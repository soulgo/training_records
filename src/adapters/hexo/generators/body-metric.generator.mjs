export class BodyMetricGenerator {
  get outputPath() {
    return 'body-metrics.json';
  }

  async generate(snapshot) {
    return {
      generatedAt: snapshot.generatedAt,
      measurements: (snapshot.daily ?? []).flatMap((day) => {
        const measurements = Array.isArray(day.measurements) && day.measurements.length > 0
          ? day.measurements
          : day.measurement
            ? [day.measurement]
            : [];
        return measurements.map((measurement) => ({
          date: day.date,
          ...measurement,
        }));
      }),
    };
  }
}
