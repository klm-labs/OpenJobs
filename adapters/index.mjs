// adapters/index.mjs — registry of all ATS adapters.
//
// Each adapter exports: { ATS, detect(company), fetchJobs(handle, ctx) }.
// See adapters/README.md for the interface.

import * as greenhouse from './greenhouse.mjs';
import * as lever from './lever.mjs';
import * as ashby from './ashby.mjs';
import * as workable from './workable.mjs';
import * as smartrecruiters from './smartrecruiters.mjs';
import * as workday from './workday.mjs';
import * as teamtailor from './teamtailor.mjs';
import * as recruitee from './recruitee.mjs';
import * as personio from './personio.mjs';
import * as breezy from './breezy.mjs';
import * as bamboohr from './bamboohr.mjs';
import * as jobvite from './jobvite.mjs';
import * as joincom from './join.mjs';
import * as a16zSpeedrun from './a16z-speedrun.mjs';
import * as getro from './getro.mjs';
import * as consider from './consider.mjs';

export const ADAPTERS = [
  greenhouse,
  lever,
  ashby,
  workable,
  smartrecruiters,
  workday,
  teamtailor,
  recruitee,
  personio,
  breezy,
  bamboohr,
  jobvite,
  joincom,
  a16zSpeedrun,
  getro,
  consider,
];

/**
 * Route a company record to the first adapter that claims it.
 * Returns { adapter, handle } or null.
 */
export function routeCompany(company) {
  for (const adapter of ADAPTERS) {
    try {
      const handle = adapter.detect(company);
      if (handle) return { adapter, handle };
    } catch (_) { /* keep trying */ }
  }
  return null;
}
