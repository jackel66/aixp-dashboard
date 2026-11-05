'use strict';
// Connector registry (CONTRACT section 16.1). A connector module exports id, label, platform,
// describe(), problems(), enabled(), test() and pull({from, to, log, progress}).
const MODULES = [require('./anthropic')];

function problemsOf(c) {
  try { return c.problems(); } catch (e) { return [e.message]; }
}

function list() {
  return MODULES.map((c) => {
    const problems = problemsOf(c);
    return {
      id: c.id, label: c.label, platform: c.platform, enabled: !!c.enabled(), configured: problems.length === 0,
      problems, describe: c.describe(),
    };
  });
}

const get = (id) => MODULES.find((c) => c.id === id) || null;
const enabledIds = () => MODULES.filter((c) => c.enabled()).map((c) => c.id);

module.exports = { list, get, enabledIds };
