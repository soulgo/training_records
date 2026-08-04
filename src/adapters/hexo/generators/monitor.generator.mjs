import { buildMonitorViewModel as defaultBuildMonitorViewModel } from '../../../site/monitor-view.mjs';

export class MonitorGenerator {
  constructor({ buildMonitorViewModel = defaultBuildMonitorViewModel } = {}) {
    this.buildMonitorViewModel = buildMonitorViewModel;
  }

  get outputPath() {
    return 'monitorView.json';
  }

  async generate(snapshot, options = {}) {
    return this.buildMonitorViewModel(snapshot, {
      ...(options.monitorViewOptions || {}),
      dailyReport: options.dailyReport,
    });
  }
}
