/*
 * cloudbeaver - Cloud Database Manager
 * Copyright (C) 2020 DBeaver Corp and others
 *
 * Licensed under the Apache License, Version 2.0.
 * you may not use this file except in compliance with the License.
 */

import { injectable } from '@dbeaver/core/di';
import { ProductManagerService } from '@dbeaver/core/product';

import { PluginSettings } from './PluginSettings';


@injectable()
export class PluginManagerService {

  constructor(private productManagerService: ProductManagerService) { }

  getPluginSettings<T>(scope: string, defaults: T) {
    return new PluginSettings(this.productManagerService.settings, scope, defaults);
  }
}
