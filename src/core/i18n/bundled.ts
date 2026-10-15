import { installTables } from './languages.js';
import { tables as tr } from './tr/tables.js';

// every table up front: browser bundle and tests
export function installBundled(): void {
  installTables('tr', tr);
}
