'use strict';
const { registerFunctions } = require('../normalize');
const { evidence, pass, fail, vis } = require('./util');

module.exports = {
  id: 'email_key_conflict',
  title: 'Each email resolves to one person',
  severity: 'fail',
  platformScoped: false,
  meaning:
    'The email bridge must give one PersonKey per full lowercase email. A conflicting mapping cannot be fixed by ' +
    'removing rows arbitrarily; it needs a documented rule or a corrected source.',
  run(ctx) {
    registerFunctions(ctx.db);
    const rows = ctx.db
      .prepare(
        `SELECT e, group_concat(k, char(31)) AS keys, count(*) AS n FROM (
           SELECT aixp_email(email) AS e, aixp_keyraw(person_key) AS k FROM stage_people WHERE dataset_id = @ds
           UNION
           SELECT aixp_email(email) AS e, aixp_keyraw(person_key) AS k FROM stage_usage WHERE dataset_id = @ds
         ) WHERE e <> '' AND k <> '' GROUP BY e HAVING count(*) > 1 ORDER BY n DESC, e`
      )
      .all({ ds: ctx.datasetId });
    const ev = evidence(['email', 'person_keys'], rows.map((r) => [r.e, vis(r.keys.split('\u001f').join(' | '))]), rows.length);
    if (rows.length) {
      return fail(null, `${rows.length} emails map to more than one person key.`, { conflictingEmails: rows.length }, ev, rows.length);
    }
    return pass(null, 'Every email resolves to one person key.', { conflictingEmails: 0 }, ev);
  },
};
