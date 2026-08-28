export class ActionRegistry {
  constructor({
    jobManager,
    prefix = 'crz'
  }) {
    if (!jobManager) {
      throw new Error(
        'ActionRegistry requires JobManager'
      );
    }

    this.jobManager =
      jobManager;

    this.prefix =
      prefix;

    this.actions =
      new Map();
  }

  register(
    name,
    handler
  ) {
    if (!name) {
      throw new Error(
        'Action name is required'
      );
    }

    if (
      typeof handler !==
      'function'
    ) {
      throw new Error(
        `Handler required for ${name}`
      );
    }

    if (
      this.actions.has(name)
    ) {
      throw new Error(
        `Action already registered: ${name}`
      );
    }

    this.actions.set(
      name,
      handler
    );

    return this;
  }

  callback(
    action,
    jobId,
    extra = null
  ) {
    const parts = [
      this.prefix,
      action,
      String(jobId)
    ];

    if (
      extra !== null &&
      extra !== undefined
    ) {
      parts.push(
        encodeURIComponent(
          String(extra)
        )
      );
    }

    const value =
      parts.join(':');

    /*
     * Telegram callback_data limit = 64 bytes.
     */
    if (
      Buffer.byteLength(
        value,
        'utf8'
      ) > 64
    ) {
      throw new Error(
        'Telegram callback_data exceeds 64 bytes'
      );
    }

    return value;
  }

  parse(data) {
    if (
      typeof data !==
      'string'
    ) {
      return null;
    }

    const parts =
      data.split(':');

    if (
      parts.length < 3 ||
      parts[0] !==
        this.prefix
    ) {
      return null;
    }

    const [
      ,
      action,
      jobId,
      ...rest
    ] = parts;

    let extra = null;

    if (rest.length) {
      try {
        extra =
          decodeURIComponent(
            rest.join(':')
          );
      } catch {
        extra =
          rest.join(':');
      }
    }

    return {
      action,
      jobId,
      extra
    };
  }

  async handle(ctx) {
    const parsed =
      this.parse(
        ctx.callbackQuery?.data
      );

    if (!parsed) {
      return false;
    }

    const handler =
      this.actions.get(
        parsed.action
      );

    /*
     * Always answer Telegram callback.
     * Never leave the button spinner hanging.
     */
    if (!handler) {
      await ctx.answerCbQuery(
        'This action is no longer available.'
      ).catch(() => {});

      return true;
    }

    const job =
      this.jobManager
        .getForUser(
          parsed.jobId,
          ctx.from.id
        );

    if (!job) {
      await ctx.answerCbQuery(
        'This job is no longer active.'
      ).catch(() => {});

      return true;
    }

    /*
     * ACK first.
     *
     * Torrent/FFmpeg/network operations must never
     * delay Telegram callback acknowledgement.
     */
    await ctx
      .answerCbQuery()
      .catch(() => {});

    try {
      await handler({
        ctx,
        job,
        action:
          parsed.action,
        extra:
          parsed.extra
      });
    } catch (error) {
      console.error(
        `[CRZ action ${parsed.action}]`,
        error
      );

      await ctx.reply(
        '⚠️ This action could not be completed. Please try again.'
      ).catch(() => {});
    }

    return true;
  }
}
