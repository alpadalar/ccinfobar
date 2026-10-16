import { applyLanguage } from '../src/cli/lang.js';
import { loadConfig } from '../src/core/config.js';
import { globMatch, PROFILES } from '../src/core/profiles.js';
import type { PriceBuiltins, ReportDeps } from '../src/core/report-types.js';
import { ledgerDir, monthFiles, rebuildSummary, stepText } from '../src/data/ledger.js';
import { accountKeysForDir } from '../src/data/limits.js';

// what cli/main.ts hands to the report command
export const BUILTINS: PriceBuiltins = { vendors: PROFILES, globMatch };

export const REPORT_DEPS: ReportDeps = {
  loadConfig,
  applyLanguage,
  ledgerDir,
  monthFiles,
  stepText,
  rebuildSummary,
  accountKeysForDir,
  profiles: BUILTINS,
};
