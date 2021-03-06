/*
 * cloudbeaver - Cloud Database Manager
 * Copyright (C) 2020 DBeaver Corp and others
 *
 * Licensed under the Apache License, Version 2.0.
 * you may not use this file except in compliance with the License.
 */

import { action, observable } from 'mobx';

import { IAgGridModel, IRequestedData } from '@dbeaver/ag-grid-plugin';
import { ErrorDetailsDialog } from '@dbeaver/core/app';
import { CommonDialogService } from '@dbeaver/core/dialogs';
import { GQLError } from '@dbeaver/core/sdk';

import { ErrorDialog } from './ErrorDialog';
import { RowDiff } from './TableDataModel/EditedRow';
import { TableColumn } from './TableDataModel/TableColumn';
import { TableDataModel } from './TableDataModel/TableDataModel';
import { TableEditor } from './TableDataModel/TableEditor';
import { SomeTableRows, TableRow } from './TableDataModel/TableRow';

export const fetchingSettings = {
  fetchMin: 1,
  fetchMax: 5000,
  fetchDefault: 200,
};

export interface IRequestDataResult {
  rows: TableRow[];
  columns: TableColumn[];
  isFullyLoaded: boolean;
  duration?: number;
  statusMessage: string;
}

export interface ITableViewerModelInit {
  initialState?: IRequestDataResult;
  requestDataAsync(rowOffset: number, count: number): Promise<IRequestDataResult>;
  noLoaderWhileRequestingDataAsync?: boolean;
  saveChanges(diffs: RowDiff[]): Promise<IRequestDataResult>;
}

export class TableViewerModel {

  agGridModel: IAgGridModel = {
    initialRows: [],
    initialColumns: [],
    chunkSize: this.getDefaultRowsCount(),
    enableRangeSelection: true,
    onRequestData: this.onRequestData.bind(this),
    onCellEditingStopped: this.onCellEditingStopped.bind(this),
    onEditSave: this.onSaveChanges.bind(this),
    onEditCancel: this.onEditCancel.bind(this),
    actions: null, // to be set by ag-grid-plugin
  };

  get isEmpty() {
    return this.tableDataModel.isEmpty();
  }
  get isLoaderVisible() {
    return this._isLoaderVisible;
  }
  get isFullyLoaded() {
    return !this._hasMoreRows;
  }

  getChunkSize = () => this._chunkSize;
  setChunkSize = (count: number) => this.updateChunkSize(count);
  handleRefresh = () => this.resetData();

  @observable queryDuration = 0;
  @observable requestStatusMessage = '';

  @observable errorMessage = '';
  @observable hasDetails = false;

  @observable private _hasMoreRows = true
  @observable private _isLoaderVisible = false;
  @observable private _chunkSize: number = this.getDefaultRowsCount();

  private exception: GQLError | null = null;
  private tableDataModel = new TableDataModel();
  private tableEditor = new TableEditor(this.tableDataModel);

  constructor(
    private init: ITableViewerModelInit,
    private commonDialogService: CommonDialogService
  ) {
    if (init.initialState) {
      this.insertRows(0, init.initialState.rows, !init.initialState.isFullyLoaded);
      this.tableDataModel.overWrite(init.initialState.columns);
      this.updateInfo(init.initialState.statusMessage, init.initialState.duration);
      this.agGridModel.initialRows = this.tableDataModel.getRows();
      this.agGridModel.initialColumns = this.tableDataModel.getColumns();
    }
  }

  cancelFetch = () => {
  }

  onShowDetails = () => {
    if (this.exception) {
      this.commonDialogService.open(ErrorDetailsDialog, this.exception);
    }
  }

  private async onCellEditingStopped(rowNumber: number, colNumber: number, value: any): Promise<void> {
    this.tableEditor.editCellValue(rowNumber, colNumber, value);
  }

  private async onRequestData(rowOffset: number, count: number): Promise<IRequestedData> {
    // try to return data from cache
    if (this.tableDataModel.isChunkLoaded(rowOffset, count) || this.isFullyLoaded) {
      const data: IRequestedData = {
        rows: this.tableDataModel.getChunk(rowOffset, count),
        columns: this.tableDataModel.getColumns(),
        isFullyLoaded: this.isFullyLoaded,
      };
      return data;
    }

    this._isLoaderVisible = !this.init.noLoaderWhileRequestingDataAsync;

    try {
      const response = await this.init.requestDataAsync(rowOffset, count);

      this.insertRows(rowOffset, response.rows, !response.isFullyLoaded);
      if (!this.tableDataModel.getColumns().length) {
        this.tableDataModel.overWrite(response.columns);
      }
      this.clearErrors();
      this.updateInfo(response.statusMessage, response.duration);
      const data: IRequestedData = {
        rows: response.rows,
        columns: response.columns,
        isFullyLoaded: response.isFullyLoaded,
      };
      return data;

    } catch (e) {
      this.showError(e);
      throw e;
    } finally {
      this._isLoaderVisible = false;
    }
  }

  @action
  private updateChunkSize(value: number) {
    this._chunkSize = this.getDefaultRowsCount(value);
    this.agGridModel.actions?.changeChunkSize(this._chunkSize);
  }

  @action
  private resetData() {
    this.tableDataModel.resetData();
    this.agGridModel.actions?.resetData();
    this.requestStatusMessage = '';
    this.queryDuration = 0;
    this._hasMoreRows = true;
    this.errorMessage = '';
  }

  @action
  private updateInfo(status: string, duration?: number) {
    this.queryDuration = duration || 0;
    this.requestStatusMessage = status;
  }

  @action
  private pushRows(rows: TableRow[], hasMore: boolean) {
    this.tableDataModel.pushRows(rows);
    this._hasMoreRows = hasMore;
  }

  @action
  private insertRows(position: number, rows: TableRow[], hasMore: boolean) {
    const isRowsAddition = this.tableDataModel.getRows().length < position + rows.length;
    this.tableDataModel.insertRows(position, rows);
    this._hasMoreRows = isRowsAddition ? hasMore : this._hasMoreRows;
  }

  private updateAgGridRows(rows: SomeTableRows) {
    rows.forEach((row, rowNumber) => {
      this.agGridModel.actions?.updateRowValue(rowNumber, row);
    });
  }

  private onEditCancel() {
    const diffs = this.tableEditor.getChanges();
    this.revertChanges(diffs);
  }

  private async onSaveChanges(): Promise<void> {
    const diffs = this.tableEditor.getChanges();

    if (!diffs.length) {
      return;
    }

    while (true) {
      try {
        await this.trySaveChanges(diffs);
        return;
      } catch (exception) {
        let hasDetails = false;
        let message = `${exception.name}: ${exception.message}`;

        if (exception instanceof GQLError) {
          hasDetails = exception.hasDetails();
          message = exception.errorText;
        }

        const tryAgain = await this.commonDialogService.open(
          ErrorDialog,
          {
            message,
            onShowDetails: hasDetails
              ? () => this.commonDialogService.open(ErrorDetailsDialog, exception)
              : undefined,
          }
        );

        if (!tryAgain) {
          this.revertChanges(diffs);
          return;
        }
      }
    }
  }

  private async trySaveChanges(diffs: RowDiff[]) {
    this._isLoaderVisible = true;

    try {
      const data = await this.init.saveChanges(diffs);

      const someRows = this.zipDiffAndResults(diffs, data.rows);
      this.tableEditor.cancelChanges();
      this.tableDataModel.updateRows(someRows);
      this.updateAgGridRows(someRows);
      this.clearErrors();
      this.updateInfo(data.statusMessage, data.duration);

    } finally {
      this._isLoaderVisible = false;
    }
  }

  private revertChanges(diffs: RowDiff[]) {
    this.tableEditor.cancelChanges();
    // revert ag-grid
    const initialRows: SomeTableRows = new Map();
    for (const diff of diffs) {
      initialRows.set(diff.rowIndex, diff.source);
    }
    this.updateAgGridRows(initialRows);
  }

  /**
   * Take array of TableRow and return sparse array of TableRow
   *
   * @param diff
   * @param newRows
   */
  private zipDiffAndResults(diff: RowDiff[], newRows: TableRow[]): SomeTableRows {
    if (diff.length !== newRows.length) {
      throw new Error('expected that new rows have same length as diff');
    }
    const newRowsMap: SomeTableRows = new Map();

    for (let i = 0; i < diff.length; i++) {
      newRowsMap.set(diff[i].rowIndex, newRows[i]);
    }

    return newRowsMap;
  }

  private showError(exception: any) {
    this.exception = null;
    this.hasDetails = false;
    if (exception instanceof GQLError) {
      this.errorMessage = exception.errorText;
      this.exception = exception;
      this.hasDetails = exception.hasDetails();
    } else {
      this.errorMessage = `${exception.name}: ${exception.message}`;
    }
  }

  private clearErrors() {
    this.errorMessage = '';
  }

  private getDefaultRowsCount(count?: number) {
    return count
      ? Math.max(
        fetchingSettings.fetchMin,
        Math.min(count, fetchingSettings.fetchMax)
      )
      : fetchingSettings.fetchDefault;
  }
}
