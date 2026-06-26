import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import frontMatter from 'hexo-front-matter';
import {
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from './lib/thought-modules.mjs';
import { readDirRecursive } from './lib/fs-walk.mjs';

const COS_UPLOAD_MAX_ATTEMPTS = 3;

export async function writeThoughtPostFile({ batch, thoughtsDir, rootDir, fetchTelegramFile }) {
  const draft = buildThoughtPost(batch);
  const postPath = path.join(thoughtsDir, draft.fileName);

  if (await fileExists(postPath)) {
    const existingMetadata = await readThoughtMetadataFromPost(postPath);
    return {
      changed: false,
      status: 'duplicate',
      postPath,
      photoPaths: existingMetadata.photoPaths,
      thoughtModule: existingMetadata.thoughtModule,
      tags: existingMetadata.tags,
    };
  }

  const photoPaths = await writeThoughtImageFiles({
    batch,
    rootDir,
    dateParts: draft.dateParts,
    sourceMessageId: draft.message.messageId,
    fetchTelegramFile,
  });
  const post = buildThoughtPost(batch, { photoPaths });

  await mkdir(thoughtsDir, { recursive: true });
  await writeFile(postPath, post.content, 'utf8');
  return {
    changed: true,
    status: 'written',
    postPath,
    photoPaths,
    thoughtModule: post.thoughtModule,
    tags: post.tags,
  };
}

export async function writeThoughtImageArtifacts({ batch, rootDir, fetchTelegramFile, imageStorage, overwrite = false }) {
  const draft = buildThoughtPost(batch);
  const artifactMessage = resolveThoughtArtifactMessage(batch);
  const thoughtModule = resolveThoughtArtifactModule(batch, draft.thoughtModule);
  const sourceChannel = batch.sourceChannel ?? artifactMessage.sourceChannel ?? 'telegram';
  const storage = imageStorage ?? createLocalImageStorage({ rootDir });
  const photoPaths = await writeThoughtImageFiles({
    batch,
    rootDir,
    dateParts: draft.dateParts,
    sourceMessageId: artifactMessage.messageId,
    fetchTelegramFile,
    imageStorage: storage,
    overwrite,
  });

  return {
    changed: photoPaths.length > 0,
    status: photoPaths.length > 0 ? 'images_written' : 'no_images',
    postPath: null,
    photoPaths,
    thoughtModule,
    tags: thoughtModule ? getThoughtModuleTags(thoughtModule, { sourceChannel }) : null,
    storageStats: photoPaths.length > 0 ? normalizeStorageStats(storage.lastUploadStats) : null,
  };
}

function normalizeStorageStats(stats) {
  if (!stats) {
    return null;
  }
  return {
    provider: stats.provider ?? null,
    bucket: stats.bucket ?? null,
    pathPrefix: stats.pathPrefix ?? null,
    uploaded: stats.uploaded ?? 0,
    skipped: stats.skipped ?? 0,
    failed: stats.failed ?? 0,
    totalUploadMs: stats.totalUploadMs ?? 0,
    maxSingleUploadMs: stats.maxSingleUploadMs ?? 0,
    firstUrlHost: stats.firstUrlHost ?? null,
  };
}

export async function editThoughtPost({ batch, thoughtsDir, rootDir, fetchTelegramFile }) {
  const target = await findThoughtPostByMessage({
    thoughtsDir,
    messageId: batch.thoughtEdit?.targetMessageId,
    chatId: batch.thoughtEdit?.telegramChatId,
  });

  if (!target) {
    return {
      changed: false,
      status: 'not_found',
      postPath: null,
    };
  }

  let nextPhotoPaths = null;
  let deletedPhotoPaths = [];
  if (batch.thoughtEdit?.replacePhotos) {
    nextPhotoPaths = await writeThoughtImageFiles({
      batch,
      rootDir,
      dateParts: resolveThoughtFrontMatterDateParts(target.frontMatter),
      sourceMessageId: batch.thoughtEdit.targetMessageId,
      fetchTelegramFile,
      overwrite: true,
    });
    deletedPhotoPaths = await deleteThoughtPhotoFiles({
      rootDir,
      photos: target.frontMatter.photos,
      excludePublicPaths: nextPhotoPaths,
    });
  }

  const nextThoughtModule = normalizeThoughtModule(
    batch.thoughtEdit?.thoughtModule ?? target.frontMatter.thought_module,
  );
  const nextTags = getThoughtModuleTags(nextThoughtModule);
  const nextContent = replaceMarkdownBody(target.raw, batch.thoughtEdit?.body ?? '', {
    photoPaths: nextPhotoPaths,
    thoughtModule: nextThoughtModule,
    tags: nextTags,
  });
  if (nextContent === target.raw) {
    if (batch.thoughtEdit?.replacePhotos && (nextPhotoPaths?.length ?? 0) > 0) {
      return {
        changed: true,
        status: 'updated',
        postPath: target.postPath,
        deletedPhotoPaths,
        photoPaths: nextPhotoPaths,
        thoughtModule: nextThoughtModule,
        tags: nextTags,
      };
    }
    return {
      changed: false,
      status: 'unchanged',
      postPath: target.postPath,
      deletedPhotoPaths,
      photoPaths: target.frontMatter.photos ?? [],
      thoughtModule: nextThoughtModule,
      tags: nextTags,
    };
  }

  await writeFile(target.postPath, nextContent, 'utf8');
  return {
    changed: true,
    status: 'updated',
    postPath: target.postPath,
    deletedPhotoPaths,
    photoPaths: nextPhotoPaths ?? target.frontMatter.photos ?? [],
    thoughtModule: nextThoughtModule,
    tags: nextTags,
  };
}

export async function deleteThoughtPost({ batch, thoughtsDir, rootDir }) {
  const target = await findThoughtPostByMessage({
    thoughtsDir,
    messageId: batch.thoughtDelete?.targetMessageId,
    chatId: batch.thoughtDelete?.telegramChatId,
  });

  if (!target) {
    return {
      changed: false,
      status: 'not_found',
      postPath: null,
      deletedPhotoPaths: [],
    };
  }

  await unlink(target.postPath);
  const deletedPhotoPaths = await deleteThoughtPhotoFiles({
    rootDir,
    photos: target.frontMatter.photos,
  });

  return {
    changed: true,
    status: 'deleted',
    postPath: target.postPath,
    deletedPhotoPaths,
    thoughtModule: normalizeThoughtModule(target.frontMatter.thought_module),
    tags: getThoughtModuleTags(normalizeThoughtModule(target.frontMatter.thought_module)),
  };
}

export async function moveThoughtPost({ batch, thoughtsDir }) {
  const target = await findThoughtPostByMessage({
    thoughtsDir,
    messageId: batch.thoughtMove?.targetMessageId,
    chatId: batch.thoughtMove?.telegramChatId,
  });

  if (!target) {
    return {
      changed: false,
      status: 'not_found',
      postPath: null,
    };
  }

  const nextThoughtModule = normalizeThoughtModule(batch.thoughtMove?.thoughtModule);
  const nextTags = getThoughtModuleTags(nextThoughtModule);
  const nextContent = replaceMarkdownBody(target.raw, target.frontMatter._content ?? '', {
    thoughtModule: nextThoughtModule,
    tags: nextTags,
  });

  if (nextContent === target.raw) {
    return {
      changed: false,
      status: 'unchanged',
      postPath: target.postPath,
      photoPaths: target.frontMatter.photos ?? [],
      thoughtModule: nextThoughtModule,
      tags: nextTags,
    };
  }

  await writeFile(target.postPath, nextContent, 'utf8');
  return {
    changed: true,
    status: 'updated',
    postPath: target.postPath,
    photoPaths: target.frontMatter.photos ?? [],
    thoughtModule: nextThoughtModule,
    tags: nextTags,
  };
}

export async function readExistingThoughtMessageKeys(thoughtsDir) {
  const keys = new Set();
  for (const postPath of await readThoughtPostPaths(thoughtsDir)) {
    try {
      const raw = await readFile(postPath, 'utf8');
      const parsed = frontMatter.parse(raw);
      const chatId = Number(parsed.telegram_chat_id);
      const messageId = Number(parsed.telegram_message_id);
      if (Number.isInteger(chatId) && Number.isInteger(messageId) && messageId > 0) {
        keys.add(`${chatId}:${messageId}`);
      }
    } catch {}
  }
  return keys;
}

function buildThoughtPost(batch, options = {}) {
  const thought = batch.thought ?? {};
  const message = resolveThoughtPostMessage(batch);
  const dateParts = formatThoughtDateParts(message.dateUnix);
  const sourceChannel = thought.sourceChannel ?? message.sourceChannel ?? batch.sourceChannel ?? 'telegram';
  const channelSlug = sourceChannel === 'feishu' ? 'feishu' : 'telegram';
  const fileName = `${dateParts.date}-${channelSlug}-thought-${message.messageId}.md`;
  const thoughtModule = normalizeThoughtModule(thought.thoughtModule);
  const tags = thought.tags ?? getThoughtModuleTags(thoughtModule, { sourceChannel });
  const lines = [
    '---',
    `date: ${dateParts.dateTime}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    `thought_module: ${thoughtModule}`,
  ];
  if (sourceChannel !== 'telegram') {
    lines.push(
      `source_channel: ${sourceChannel}`,
      `source_message_id: ${message.sourceMessageId ?? ''}`,
      `source_chat_id: ${message.sourceChatId ?? message.chatId ?? ''}`,
    );
  }
  lines.push(
    `telegram_message_id: ${message.messageId ?? ''}`,
    `telegram_chat_id: ${Number.isFinite(Number(message.chatId)) ? message.chatId : ''}`,
  );
  if (options.photoPaths?.length) {
    lines.push('photos:');
    for (const photoPath of options.photoPaths) {
      lines.push(`  - ${photoPath}`);
    }
  }
  lines.push('---', '', thought.body ?? '', '');

  return {
    fileName,
    content: lines.join('\n'),
    dateParts,
    message,
    thoughtModule,
    tags,
  };
}

async function findThoughtPostByMessage({ thoughtsDir, messageId, chatId }) {
  if (!messageId) {
    return null;
  }

  const suffix = `-telegram-thought-${messageId}.md`;
  const candidatePaths = await readThoughtPostPaths(thoughtsDir);
  const directPaths = candidatePaths.filter((entry) => entry.endsWith(suffix));
  const pathsToCheck = directPaths.length > 0 ? directPaths : candidatePaths;

  for (const postPath of pathsToCheck) {
    const raw = await readFile(postPath, 'utf8');
    const parsed = frontMatter.parse(raw);
    const frontMatterData = normalizeThoughtFrontMatter(parsed);
    if (
      Number(frontMatterData.telegram_message_id) === Number(messageId) &&
      (chatId == null || Number(frontMatterData.telegram_chat_id) === Number(chatId))
    ) {
      return {
        postPath,
        raw,
        frontMatter: frontMatterData,
      };
    }
  }

  return null;
}

async function readThoughtPostPaths(thoughtsDir) {
  return (await readDirRecursive(thoughtsDir, {
    filter: (entryPath) => isThoughtPostPath(entryPath),
  })).sort((left, right) => left.localeCompare(right));
}

function isThoughtPostPath(entryPath) {
  return /(?:^|[/\\])[^/\\]+-(?:telegram|feishu)-thought-\d+\.md$/u.test(entryPath);
}

function normalizeThoughtFrontMatter(parsed) {
  const { _content = '', ...frontMatterData } = parsed ?? {};
  return {
    ...frontMatterData,
    _content,
  };
}

async function readThoughtMetadataFromPost(postPath) {
  try {
    const raw = await readFile(postPath, 'utf8');
    const parsed = frontMatter.parse(raw);
    const thoughtModule = normalizeThoughtModule(parsed.thought_module);
    return {
      photoPaths: Array.isArray(parsed.photos) ? parsed.photos : [],
      thoughtModule,
      tags: getThoughtModuleTags(thoughtModule),
    };
  } catch {
    return {
      photoPaths: [],
      thoughtModule: 'workout',
      tags: getThoughtModuleTags('workout'),
    };
  }
}

function replaceMarkdownBody(raw, nextBody, options = {}) {
  const split = frontMatter.split(raw);
  const parsed = frontMatter.parse(raw);
  const { _content, ...frontMatterData } = parsed ?? {};
  if (options.thoughtModule) {
    frontMatterData.thought_module = normalizeThoughtModule(options.thoughtModule);
    frontMatterData.tags = getThoughtModuleTags(frontMatterData.thought_module);
  }
  if (Array.isArray(options.photoPaths)) {
    if (options.photoPaths.length > 0) {
      frontMatterData.photos = options.photoPaths;
    } else {
      delete frontMatterData.photos;
    }
  }
  return `${frontMatter.stringify(frontMatterData, {
    separator: split.separator,
    prefixSeparator: split.prefixSeparator,
  })}\n${String(nextBody ?? '').trim()}\n`;
}

function resolveThoughtFrontMatterDateParts(frontMatterData) {
  const rawDate = frontMatterData?.date;
  const date =
    rawDate instanceof Date
      ? rawDate
      : rawDate
        ? new Date(rawDate)
        : null;
  if (date && !Number.isNaN(date.getTime())) {
    return formatThoughtDateParts(Math.floor(date.getTime() / 1000));
  }
  return formatThoughtDateParts(0);
}

async function deleteThoughtPhotoFiles({ rootDir, photos, excludePublicPaths = [] }) {
  const deletedPhotoPaths = [];
  const excluded = new Set(
    excludePublicPaths
      .map((photoPath) =>
        typeof photoPath === 'string' && photoPath.startsWith('/images/')
          ? path.join(rootDir, 'source', photoPath.replace(/^\//, ''))
          : null,
      )
      .filter(Boolean),
  );
  for (const photoPath of resolveThoughtPhotoFilePaths({ rootDir, photos })) {
    if (excluded.has(photoPath)) {
      continue;
    }
    if (await fileExists(photoPath)) {
      await unlink(photoPath);
      deletedPhotoPaths.push(photoPath);
    }
  }
  return deletedPhotoPaths;
}

function resolveThoughtPhotoFilePaths({ rootDir, photos }) {
  if (!Array.isArray(photos) || !rootDir) {
    return [];
  }

  return photos
    .map((photoPath) =>
      typeof photoPath === 'string' && photoPath.startsWith('/images/')
        ? path.join(rootDir, 'source', photoPath.replace(/^\//, ''))
        : null,
    )
    .filter(Boolean);
}

async function writeThoughtImageFiles({
  batch,
  rootDir,
  dateParts,
  sourceMessageId,
  fetchTelegramFile,
  imageStorage,
  overwrite = false,
}) {
  if (!rootDir || !fetchTelegramFile) {
    return [];
  }

  const imageMessages = (batch.messages ?? [])
    .map((message) => ({
      message,
      photo: selectThoughtImagePhoto(message),
    }))
    .filter((item) => item.photo?.fileId)
    .sort((left, right) => left.message.messageId - right.message.messageId);
  if (imageMessages.length === 0) {
    return [];
  }

  const storage = imageStorage ?? createLocalImageStorage({ rootDir });
  const imageItems = [];

  for (let index = 0; index < imageMessages.length; index += 1) {
    const { message, photo } = imageMessages[index];
    const file = await fetchTelegramFile(photo.fileId, { message, photo });
    const extension = inferThoughtImageExtension(photo, file);
    const channelSlug = message.sourceChannel === 'feishu' ? 'feishu' : 'telegram';
    imageItems.push({
      data: file.data,
      extension,
      channelSlug,
      dateParts,
      sourceMessageId,
      index: index + 1,
      overwrite,
    });
  }

  return storage.upload(imageItems);
}

export function createImageStorage({ env = process.env, rootDir, createCosClient } = {}) {
  const enabled = String(env.COS_ENABLED ?? '').trim().toLowerCase() === 'true';
  const provider = String(env.COS_PROVIDER ?? (enabled ? 'tencent_cos' : 'github_local')).trim() || 'github_local';
  if (!enabled || provider === 'github_local') {
    return createLocalImageStorage({ rootDir });
  }
  if (provider !== 'tencent_cos') {
    throw new Error(`Unsupported image storage provider: ${provider}`);
  }
  return createTencentCosImageStorage({ env, createCosClient });
}

function createLocalImageStorage({ rootDir }) {
  return {
    provider: 'github_local',
    lastUploadStats: createEmptyUploadStats('github_local'),
    async upload(imageItems) {
      const stats = createEmptyUploadStats('github_local');
      const publicPaths = [];
      for (const item of imageItems) {
        const imagePath = buildThoughtImagePath(item);
        const outputDir = path.join(rootDir, 'source', 'images', 'thoughts', imagePath.year, imagePath.month);
        const outputPath = path.join(outputDir, imagePath.fileName);
        await mkdir(outputDir, { recursive: true });
        const startedAt = Date.now();
        if (item.overwrite || !(await fileExists(outputPath))) {
          await writeFile(outputPath, item.data);
          stats.uploaded += 1;
        } else {
          stats.skipped += 1;
        }
        const publicPath = `/images/thoughts/${imagePath.year}/${imagePath.month}/${imagePath.fileName}`;
        recordUploadTiming(stats, startedAt);
        if (!stats.firstUrlHost && publicPath) {
          stats.firstUrlHost = '/images/thoughts';
        }
        publicPaths.push(publicPath);
      }
      this.lastUploadStats = stats;
      return publicPaths;
    },
  };
}

function createTencentCosImageStorage({ env, createCosClient } = {}) {
  const config = resolveTencentCosConfig(env);
  let clientPromise = null;
  const getClient = async () => {
    if (clientPromise) {
      return clientPromise;
    }
    clientPromise = Promise.resolve(
      createCosClient
        ? createCosClient(config)
        : import('cos-nodejs-sdk-v5').then(({ default: COS }) =>
            new COS({
              SecretId: config.secretId,
              SecretKey: config.secretKey,
            })
          ),
    );
    return clientPromise;
  };

  return {
    provider: 'tencent_cos',
    lastUploadStats: createEmptyUploadStats('tencent_cos', config),
    async upload(imageItems) {
      const stats = createEmptyUploadStats('tencent_cos', config);
      const urls = [];
      const client = await getClient();
      for (const item of imageItems) {
        const key = buildTencentCosThoughtKey(item, config.pathPrefix);
        const startedAt = Date.now();
        try {
          await uploadTencentCosObject({
            client,
            config,
            key,
            body: item.data,
            contentType: inferContentType(item.extension),
            stats,
          });
          const url = `${config.domain}/${key}`;
          if (!stats.firstUrlHost) {
            stats.firstUrlHost = safeUrlHost(url);
          }
          urls.push(url);
        } catch (error) {
          stats.failed += 1;
          recordUploadTiming(stats, startedAt);
          this.lastUploadStats = stats;
          throw error;
        }
        recordUploadTiming(stats, startedAt);
      }
      this.lastUploadStats = stats;
      return urls;
    },
  };
}

function createEmptyUploadStats(provider, config = {}) {
  return {
    provider,
    bucket: config.bucket ?? null,
    pathPrefix: config.pathPrefix ?? null,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    totalUploadMs: 0,
    maxSingleUploadMs: 0,
    firstUrlHost: null,
  };
}

function recordUploadTiming(stats, startedAt) {
  const duration = Date.now() - startedAt;
  stats.totalUploadMs += duration;
  if (duration > stats.maxSingleUploadMs) {
    stats.maxSingleUploadMs = duration;
  }
}

function safeUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function resolveTencentCosConfig(env = process.env) {
  const config = {
    secretId: trimEnv(env.COS_SECRET_ID),
    secretKey: trimEnv(env.COS_SECRET_KEY),
    bucket: trimEnv(env.COS_BUCKET),
    region: trimEnv(env.COS_REGION),
    domain: trimEnv(env.COS_DOMAIN).replace(/\/+$/u, ''),
    pathPrefix: trimEnv(env.COS_PATH_PREFIX).replace(/^\/+|\/+$/gu, ''),
  };
  const required = [
    ['COS_SECRET_ID', config.secretId],
    ['COS_SECRET_KEY', config.secretKey],
    ['COS_BUCKET', config.bucket],
    ['COS_REGION', config.region],
    ['COS_DOMAIN', config.domain],
    ['COS_PATH_PREFIX', config.pathPrefix],
  ];
  const missing = required.find(([, value]) => !value);
  if (missing) {
    throw new Error(`Missing required COS configuration: ${missing[0]}`);
  }
  if (!config.domain.startsWith('https://')) {
    throw new Error('Invalid COS configuration: COS_DOMAIN must start with https://');
  }
  // 未备案域名阶段：COS_DOMAIN 必须使用 COS 默认公网域名（https://{COS_BUCKET}.cos.{COS_REGION}.myqcloud.com）。
  // 自定义域名需先完成 ICP 备案与 HTTPS 配置；此处 fail-fast 防止误填不可访问的未备案域名。
  const expectedDefaultDomain = `https://${config.bucket}.cos.${config.region}.myqcloud.com`;
  if (config.domain !== expectedDefaultDomain) {
    throw new Error(
      `Invalid COS configuration: COS_DOMAIN must match the default COS domain format ` +
        `(${expectedDefaultDomain}) in the unfiled-domain phase; custom domains require ICP filing and HTTPS before use`,
    );
  }
  if (config.pathPrefix.includes('..') || config.pathPrefix.includes('\\')) {
    throw new Error('Invalid COS configuration: COS_PATH_PREFIX must not contain .. or backslashes');
  }
  return config;
}

function trimEnv(value) {
  return String(value ?? '').trim();
}

async function uploadTencentCosObject({ client, config, key, body, contentType, stats }) {
  if (await tencentCosObjectExists({ client, config, key, tolerateTransientError: true })) {
    if (stats) {
      stats.skipped += 1;
    }
    return;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= COS_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      await callCos(client, 'putObject', {
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Body: body,
        ContentType: contentType,
      });
      if (stats) {
        stats.uploaded += 1;
      }
      return;
    } catch (error) {
      lastError = error;
      if (isCosPermissionOrConfigError(error) || attempt === COS_UPLOAD_MAX_ATTEMPTS) {
        break;
      }
      process.stderr.write(
        `[image-storage] COS PutObject failed for ${key}: ${formatErrorMessage(error)}; retrying (${attempt}/${COS_UPLOAD_MAX_ATTEMPTS})\n`,
      );
    }
  }

  if (await tencentCosObjectExists({ client, config, key, tolerateTransientError: false })) {
    if (stats) {
      stats.skipped += 1;
    }
    return;
  }
  throw new Error(`COS PutObject failed for ${key}: ${formatErrorMessage(lastError)}`);
}

async function tencentCosObjectExists({ client, config, key, tolerateTransientError = false }) {
  try {
    const result = await callCos(client, 'headObject', {
      Bucket: config.bucket,
      Region: config.region,
      Key: key,
    });
    const length = Number(result?.headers?.['content-length'] ?? result?.headers?.['Content-Length'] ?? NaN);
    return !Number.isFinite(length) || length > 0;
  } catch (error) {
    if (Number(error?.statusCode) === 404) {
      return false;
    }
    if (tolerateTransientError && !isCosPermissionOrConfigError(error)) {
      process.stderr.write(
        `[image-storage] COS HeadObject failed for ${key}: ${formatErrorMessage(error)}; attempting upload\n`,
      );
      return false;
    }
    throw error;
  }
}

function callCos(client, method, input) {
  return promisify(client[method].bind(client))(input);
}

function isCosPermissionOrConfigError(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  return statusCode === 401 || statusCode === 403 || statusCode === 404;
}

function buildTencentCosThoughtKey(item, pathPrefix) {
  const imagePath = buildThoughtImagePath(item);
  return `${pathPrefix}/thoughts/${imagePath.year}/${imagePath.month}/${imagePath.fileName}`;
}

function buildThoughtImagePath(item) {
  const [year, month] = item.dateParts.date.split('-');
  const fileName = `${item.dateParts.date}-${item.channelSlug}-thought-${item.sourceMessageId}-${item.index}${item.extension}`;
  return { year, month, fileName };
}

function inferContentType(extension) {
  const normalized = String(extension ?? '').toLowerCase();
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
  };
  return contentTypes[normalized] ?? 'application/octet-stream';
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || 'unknown error';
  }
  if (!error || typeof error !== 'object') {
    return String(error ?? 'unknown error');
  }

  const fields = [];
  const addField = (label, value) => {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      fields.push(`${label}=${normalized}`);
    }
  };

  const message = String(error.message ?? error.Message ?? '').trim();
  const code = error.Code ?? error.code ?? error.Error?.Code ?? error.Error?.code;
  const statusCode = error.statusCode ?? error.status ?? error.Error?.statusCode;
  const requestId =
    error.RequestId ??
    error.requestId ??
    error.headers?.['x-cos-request-id'] ??
    error.headers?.['x-ci-request-id'] ??
    error.headers?.['X-Cos-Request-Id'] ??
    error.headers?.['X-Ci-Request-Id'];

  if (message) {
    fields.push(message);
  }
  addField('Code', code);
  addField('statusCode', statusCode);
  addField('RequestId', requestId);

  if (fields.length === 0) {
    for (const [key, value] of Object.entries(error)) {
      const normalizedKey = String(key);
      if (/secret|authorization|signature|token|key/iu.test(normalizedKey)) {
        continue;
      }
      if (value === null || value === undefined || typeof value === 'object') {
        continue;
      }
      addField(normalizedKey, value);
    }
  }

  return truncateErrorMessage(fields.join(' ') || 'unknown error');
}

function truncateErrorMessage(message, maxLength = 500) {
  return message.length > maxLength ? `${message.slice(0, maxLength - 3)}...` : message;
}

function resolveThoughtPostMessage(batch) {
  const sourceMessageId = batch.thought?.sourceMessageId ?? null;
  return (
    (batch.messages ?? []).find((message) => message.messageId === sourceMessageId) ??
    batch.messages?.[0] ??
    {}
  );
}

function resolveThoughtArtifactMessage(batch) {
  const baseMessage = resolveThoughtPostMessage(batch);
  const targetMessageId = batch.thoughtEdit?.targetMessageId ?? batch.thought?.sourceMessageId ?? null;
  return {
    ...baseMessage,
    messageId: targetMessageId ?? baseMessage.messageId,
  };
}

function resolveThoughtArtifactModule(batch, fallbackModule) {
  if (batch.kind === 'thought') {
    return normalizeThoughtModule(batch.thought?.thoughtModule ?? fallbackModule);
  }
  return normalizeThoughtModuleOrNull(
    batch.thoughtEdit?.thoughtModule ??
    batch.thoughtDelete?.thoughtModule ??
    batch.thoughtMove?.thoughtModule,
  );
}

function selectThoughtImagePhoto(message) {
  const photos = message.photos ?? [];
  const documentImage = photos.find((photo) => photo.source === 'document');
  if (documentImage) {
    return documentImage;
  }

  return (
    photos
      .filter((photo) => photo.source === 'photo' || photo.source === 'feishu_image')
      .toSorted((left, right) => thoughtPhotoScore(right) - thoughtPhotoScore(left))
      .at(0) ?? null
  );
}

function thoughtPhotoScore(photo) {
  if (Number.isFinite(photo.fileSize)) {
    return photo.fileSize;
  }
  return (photo.width ?? 0) * (photo.height ?? 0);
}

function inferThoughtImageExtension(photo, file) {
  const fromName = path.extname(photo.fileName ?? file.filePath ?? '').toLowerCase();
  if (/^\.(?:jpe?g|png|webp|gif|bmp|heic|heif|tiff?)$/.test(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }

  const mimeType = (photo.mimeType ?? file.contentType ?? '').toLowerCase().split(';')[0].trim();
  const extensionByMimeType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/tiff': '.tiff',
  };
  return extensionByMimeType[mimeType] ?? '.jpg';
}

export function formatThoughtDateParts(dateUnix) {
  const date = new Date((dateUnix ?? 0) * 1000);
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
