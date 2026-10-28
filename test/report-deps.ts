import { applyLanguage } from '../src/cli/lang.js';
import { loadConfig } from '../src/core/config.js';
import { PRICES_UPDATED, priceFor, requestCost } from '../src/core/prices.js';
import { globMatch, PROFILES } from '../src/core/profiles.js';
import type { PriceBuiltins, PriceDeps, ReportDeps } from '../src/core/report-types.js';
import { ledgerDir, monthFiles, projectHash, rebuildSummary, stepText } from '../src/data/ledger.js';
import { accountKeysForDir } from '../src/data/limits.js';

// what cli/main.ts hands to the report command
export const BUILTINS: PriceBuiltins = { vendors: PROFILES, globMatch };

export const PRICE_DEPS: PriceDeps = { priceFor, requestCost, updated: PRICES_UPDATED };

export const REPORT_DEPS: ReportDeps = {
  loadConfig,
  applyLanguage,
  ledgerDir,
  monthFiles,
  projectHash,
  stepText,
  rebuildSummary,
  accountKeysForDir,
  profiles: BUILTINS,
  prices: PRICE_DEPS,
};
