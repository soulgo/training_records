export class ThoughtRepositoryPort {
  async findByTelegramMessageId(_messageId) {
    throw new Error('Not implemented: ThoughtRepositoryPort.findByTelegramMessageId');
  }

  async save(_thought) {
    throw new Error('Not implemented: ThoughtRepositoryPort.save');
  }
}
