import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import frontMatter from 'hexo-front-matter';
import {
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from './lib/thought-modules.mjs';
import { readDirRecursive } from './lib/fs-walk.mjs';

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

export async function writeThoughtImageArtifacts({ batch, rootDir, fetchTelegramFile, overwrite = false }) {
  const draft = buildThoughtPost(batch);
  const artifactMessage = resolveThoughtArtifactMessage(batch);
  const thoughtModule = resolveThoughtArtifactModule(batch, draft.thoughtModule);
  const photoPaths = await writeThoughtImageFiles({
    batch,
    rootDir,
    dateParts: draft.dateParts,
    sourceMessageId: artifactMessage.messageId,
    fetchTelegramFile,
    overwrite,
  });

  return {
    changed: photoPaths.length > 0,
    status: photoPaths.length > 0 ? 'images_written' : 'no_images',
    postPath: null,
    photoPaths,
    thoughtModule,
    tags: thoughtModule ? getThoughtModuleTags(thoughtModule) : null,
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
  const fileName = `${dateParts.date}-telegram-thought-${message.messageId}.md`;
  const thoughtModule = normalizeThoughtModule(thought.thoughtModule);
  const tags = getThoughtModuleTags(thoughtModule);
  const lines = [
    '---',
    `date: ${dateParts.dateTime}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    `thought_module: ${thoughtModule}`,
    `telegram_message_id: ${message.messageId ?? ''}`,
    `telegram_chat_id: ${message.chatId ?? ''}`,
  ];
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
  return /(?:^|[/\\])[^/\\]+-telegram-thought-\d+\.md$/u.test(entryPath);
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

  const [year, month] = dateParts.date.split('-');
  const outputDir = path.join(rootDir, 'source', 'images', 'thoughts', year, month);
  const publicPaths = [];

  for (let index = 0; index < imageMessages.length; index += 1) {
    const { photo } = imageMessages[index];
    const file = await fetchTelegramFile(photo.fileId);
    const extension = inferThoughtImageExtension(photo, file);
    const imageFileName = `${dateParts.date}-telegram-thought-${sourceMessageId}-${index + 1}${extension}`;
    const outputPath = path.join(outputDir, imageFileName);
    const publicPath = `/images/thoughts/${year}/${month}/${imageFileName}`;

    await mkdir(outputDir, { recursive: true });
    if (overwrite || !(await fileExists(outputPath))) {
      await writeFile(outputPath, file.data);
    }
    publicPaths.push(publicPath);
  }

  return publicPaths;
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
      .filter((photo) => photo.source === 'photo')
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
