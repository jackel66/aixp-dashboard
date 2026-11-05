'use strict';
// Connector registry (CONTRACT section 16.1). A connector module exports id, label, platform,
// describe(), problems(), enabled(), test() and pull({from, to, log, progress}).
// The GitHub, OpenAI and Cowork modules land from separate builders; a missing file must not stop boot.
function load(name) {
  try { return require(name); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(name.replace('./', ''))) {
      console.warn(`[connectors] ${name} is not available yet: ${String(e.message).split(String.fromCharCode(10))[0]}`);
      return null;
    }
    throw e;
  }
}
const MODULES = [require('./anthropic'), load('./github'), load('./openai'), load('./cowork')].filter(Boolean);

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
