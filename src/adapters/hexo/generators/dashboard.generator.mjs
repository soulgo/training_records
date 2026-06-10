import { buildDashboardViewModel as defaultBuildDashboardViewModel } from '../../../site/dashboard-view.mjs';

export class DashboardGenerator {
  constructor({ buildDashboardViewModel = defaultBuildDashboardViewModel } = {}) {
    this.buildDashboardViewModel = buildDashboardViewModel;
  }

  get outputPath() {
    return 'dashboardView.json';
  }

  async generate(snapshot) {
    return this.buildDashboardViewModel(snapshot);
  }
}
