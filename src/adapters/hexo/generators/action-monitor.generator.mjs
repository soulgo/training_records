import { buildActionMonitorViewModel } from '../../../site/action-monitor-view.mjs';

export class ActionMonitorGenerator {
  constructor({ loadActionMonitorView } = {}) {
    this.loadActionMonitorView = loadActionMonitorView;
  }

  get outputPath() {
    return 'actionMonitorView.json';
  }

  async generate(_snapshot, options = {}) {
    if (typeof this.loadActionMonitorView === 'function') {
      return this.loadActionMonitorView(options);
    }
    return buildActionMonitorViewModel([], {
      environment: resolveEnvironment(options.env),
      now: options.now,
    });
  }
}

function resolveEnvironment(env = {}) {
  return env.GITHUB_ACTION_MONITOR_ENVIRONMENT ||
    env.GITHUB_REF_NAME ||
    env.CF_PAGES_BRANCH ||
    'dev';
}
