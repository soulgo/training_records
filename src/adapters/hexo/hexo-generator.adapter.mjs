import { HexoGeneratorPort } from './hexo-generator.port.mjs';

export class HexoGeneratorAdapter extends HexoGeneratorPort {
  constructor({ generateTrainingData, generators = [], writeJson } = {}) {
    super();
    this.generateTrainingData = generateTrainingData;
    this.generators = generators;
    this.writeJson = writeJson;
  }

  async generate(options = {}) {
    if (this.generators.length > 0) {
      if (!options.snapshot) {
        throw new Error('HexoGeneratorAdapter requires snapshot when using split generators');
      }
      if (typeof this.writeJson !== 'function') {
        throw new Error('HexoGeneratorAdapter requires writeJson when using split generators');
      }

      const outputs = [];
      for (const generator of this.generators) {
        const payload = await generator.generate(options.snapshot, options);
        await this.writeJson(generator.outputPath, payload, options);
        outputs.push(generator.outputPath);
      }
      return { outputs };
    }

    if (typeof this.generateTrainingData === 'function') {
      return this.generateTrainingData(options);
    }

    throw new Error('HexoGeneratorAdapter requires generateTrainingData or split generators');
  }
}
