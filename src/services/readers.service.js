import { ApiError } from '../errors/ApiError.js';
import * as readersRepository from '../repositories/readers.repository.js';

function toReader(row) {
  return {
    id: Number(row.id),
    fullName: row.full_name,
    email: row.email,
    registrationNumber: row.registration_number,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUniqueConflict(error) {
  if (error.code === '23505') {
    if (error.constraint === 'readers_email_lower_key') {
      return new ApiError(409, 'EMAIL_ALREADY_EXISTS', 'Читатель с таким email уже зарегистрирован');
    }
    if (error.constraint === 'readers_registration_number_key') {
      return new ApiError(409, 'REGISTRATION_NUMBER_ALREADY_EXISTS', 'Читатель с таким регистрационным номером уже зарегистрирован');
    }
  }
  return error;
}

export async function createReader(data) {
  try {
    return toReader(await readersRepository.insertReader(data));
  } catch (error) {
    throw mapUniqueConflict(error);
  }
}

export async function getReaderById(id) {
  const row = await readersRepository.findReaderById(id);
  if (!row) throw new ApiError(404, 'READER_NOT_FOUND', 'Читатель не найден');
  return toReader(row);
}

export async function listReaders(query) {
  const { rows, total } = await readersRepository.findReaders(query);
  return {
    data: rows.map(toReader),
    pagination: {
      page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function updateReader(id, data) {
  try {
    const row = await readersRepository.updateReaderFields(id, data);
    if (!row) throw new ApiError(404, 'READER_NOT_FOUND', 'Читатель не найден');
    return toReader(row);
  } catch (error) {
    throw mapUniqueConflict(error);
  }
}
