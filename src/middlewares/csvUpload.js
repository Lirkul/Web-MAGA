import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { ApiError } from '../errors/ApiError.js';

const maxFileSize = 10 * 1024 * 1024;

// Файл живёт только во время запроса. HTTP-загрузка и запись на диск связаны backpressure.
export async function withCsvUpload(req, consume, signal) {
  let multipart;
  try {
    if (!req.is('multipart/form-data')) throw new Error('Expected multipart');
    multipart = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      // Busboy сообщает о достижении лимита: +1 позволяет принять ровно 10 МиБ.
      limits: { fileSize: maxFileSize + 1, files: 1, fields: 0 },
    });
  } catch {
    throw ApiError.badRequest('Ожидается multipart/form-data с CSV-файлом в поле file');
  }

  const directory = await mkdtemp(join(tmpdir(), 'web-maga-csv-'));
  const path = join(directory, 'catalog.csv');
  let received = false;
  let uploadError;
  let saving = Promise.resolve();
  const invalidUpload = () => { uploadError ??= ApiError.badRequest('Передайте только один CSV-файл в поле file'); };
  const abort = () => {
    uploadError ??= ApiError.badRequest('Загрузка CSV прервана');
    multipart.destroy(uploadError);
  };

  multipart.on('file', (field, file, { filename }) => {
    file.on('error', () => {}); // Ошибка формы обрабатывается на multipart-парсере.
    if (field !== 'file' || extname(filename || '').toLowerCase() !== '.csv') {
      invalidUpload();
      file.resume();
      return;
    }
    received = true;
    file.once('limit', () => {
      uploadError = new ApiError(413, 'CSV_TOO_LARGE', 'Размер CSV превышает 10 МиБ');
    });
    saving = pipeline(file, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
      .catch((error) => {
        uploadError ??= error;
        multipart.destroy(error);
      });
  });
  multipart.on('filesLimit', invalidUpload);
  multipart.on('fieldsLimit', invalidUpload);
  multipart.on('error', () => { uploadError ??= ApiError.badRequest('Некорректная multipart-форма'); });
  const uploaded = finished(multipart, { cleanup: true }).catch(() => {
    uploadError ??= ApiError.badRequest('Некорректная multipart-форма');
  });
  req.once('aborted', abort);
  req.once('error', abort);
  signal?.addEventListener('abort', abort, { once: true });

  try {
    if (req.aborted || signal?.aborted) abort();
    else req.pipe(multipart);
    await uploaded;
    await saving;
    if (uploadError) throw uploadError;
    if (!received) throw ApiError.badRequest('CSV-файл в поле file не передан');
    return await consume(path);
  } finally {
    req.unpipe(multipart);
    req.off('aborted', abort);
    req.off('error', abort);
    signal?.removeEventListener('abort', abort);
    multipart.destroy();
    if (!req.complete && !req.destroyed) req.resume();
    await saving;
    await rm(path, { force: true });
    await rmdir(directory);
  }
}
