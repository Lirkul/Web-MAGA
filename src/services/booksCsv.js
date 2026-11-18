import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { CsvError, parse } from 'csv-parse';
import { ApiError } from '../errors/ApiError.js';

const columns = ['title', 'authors', 'isbn', 'publicationYear', 'genre', 'totalCopies'];

function lineBreaks(value) {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\r') {
      count++;
      if (value[index + 1] === '\n') index++;
    } else if (value[index] === '\n') count++;
  }
  return count;
}

export async function readBooksCsv(path, consume, signal) {
  let headers;
  let nextLine = 1;
  const parser = parse({
    bom: true, trim: true, raw: true,
    record_delimiter: ['\r\n', '\n'],
    // Пустые физические строки обрабатываем сами, чтобы точно считать номера строк.
    relax_column_count: true,
    max_record_size: 10 * 1024 * 1024,
  });

  try {
    await pipeline(createReadStream(path, { highWaterMark: 16 * 1024 }), parser, async (records) => {
      for await (const { record, raw } of records) {
        signal?.throwIfAborted();
        const row = nextLine;
        nextLine += lineBreaks(raw);
        if (raw.trim() === '') continue;
        if (!headers) {
          headers = record.map((value) => value.trim());
          if (headers.length !== columns.length || new Set(headers).size !== columns.length
            || columns.some((name) => !headers.includes(name))) {
            throw new ApiError(400, 'CSV_INVALID_HEADERS', `Ожидаются колонки: ${columns.join(',')}`);
          }
          continue;
        }
        if (record.length !== headers.length) {
          await consume(null, row, 'Число значений не совпадает с числом колонок');
          continue;
        }
        const values = Object.fromEntries(headers.map((name, index) => [name, record[index].trim()]));
        // Следующая запись не сохраняется, пока не завершился INSERT текущей.
        await consume(values, row);
      }
    }, { signal });
  } catch (error) {
    if (error instanceof CsvError) {
      throw new ApiError(400, 'CSV_INVALID', 'Некорректная структура CSV');
    }
    throw error;
  }
  if (!headers) throw new ApiError(400, 'CSV_EMPTY', 'CSV пуст или не содержит заголовков');
}
