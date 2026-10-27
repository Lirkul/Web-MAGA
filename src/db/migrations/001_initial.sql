CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 255 AND length(trim(title)) > 0),
  authors TEXT NOT NULL CHECK (
    CASE WHEN json_valid(authors)
      THEN json_type(authors) = 'array' AND json_array_length(authors) >= 1
      ELSE 0
    END
  ),
  -- ISBN хранится уже без пробелов и дефисов; нормализация входа появится в этапе 2.
  isbn TEXT NOT NULL UNIQUE CHECK (
    (length(isbn) = 13 AND isbn NOT GLOB '*[^0-9]*') OR
    (length(isbn) = 10 AND substr(isbn, 1, 9) NOT GLOB '*[^0-9]*'
      AND substr(isbn, 10, 1) GLOB '[0-9X]')
  ),
  publishedYear INTEGER NOT NULL CHECK (publishedYear >= 1450),
  genre TEXT NOT NULL CHECK (length(genre) BETWEEN 1 AND 100 AND length(trim(genre)) > 0),
  totalCopies INTEGER NOT NULL CHECK (totalCopies >= 1),
  isArchived INTEGER NOT NULL DEFAULT 0 CHECK (isArchived IN (0, 1)),
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE readers (
  id INTEGER PRIMARY KEY,
  fullName TEXT NOT NULL CHECK (length(fullName) BETWEEN 2 AND 200 AND length(trim(fullName)) >= 2),
  -- Базовая проверка формы; полная валидация email относится к HTTP-слою этапа 2.
  email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (
    email LIKE '%_@_%._%' AND email NOT GLOB ('*[ ' || char(9, 10, 13) || ']*')
  ),
  registrationNumber TEXT NOT NULL UNIQUE CHECK (length(trim(registrationNumber)) > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED')),
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  bookId INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  readerId INTEGER NOT NULL REFERENCES readers(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  loanedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dueDate TEXT NOT NULL CHECK (
    dueDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(dueDate, '+0 days') IS dueDate
  ),
  returnedAt TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'OVERDUE', 'RETURNED')),
  fineAmount INTEGER NOT NULL DEFAULT 0 CHECK (fineAmount >= 0),
  CHECK (
    (status = 'RETURNED' AND returnedAt IS NOT NULL) OR
    (status IN ('ACTIVE', 'OVERDUE') AND returnedAt IS NULL)
  )
) STRICT;

CREATE INDEX idx_loans_book_status ON loans(bookId, status);
CREATE INDEX idx_loans_reader_status ON loans(readerId, status);
CREATE INDEX idx_loans_due_date_status ON loans(dueDate, status);
CREATE INDEX idx_loans_loaned_at ON loans(loanedAt);

-- Текущий год меняется, поэтому верхнюю границу проверяем триггерами,
-- а не CHECK с недетерминированным strftime(..., 'now').
-- Тип каждого элемента JSON-массива также проверяется здесь.
CREATE TRIGGER books_validate_insert
BEFORE INSERT ON books
BEGIN
  SELECT RAISE(ABORT, 'publishedYear exceeds next year')
    WHERE NEW.publishedYear > CAST(strftime('%Y', 'now') AS INTEGER) + 1;
  SELECT RAISE(ABORT, 'authors must contain non-empty strings')
    WHERE EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.authors) THEN NEW.authors ELSE '[]' END)
      WHERE type <> 'text' OR length(trim(value)) = 0
    );
END;

CREATE TRIGGER books_validate_update
BEFORE UPDATE OF authors, publishedYear ON books
BEGIN
  SELECT RAISE(ABORT, 'publishedYear exceeds next year')
    WHERE NEW.publishedYear > CAST(strftime('%Y', 'now') AS INTEGER) + 1;
  SELECT RAISE(ABORT, 'authors must contain non-empty strings')
    WHERE EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.authors) THEN NEW.authors ELSE '[]' END)
      WHERE type <> 'text' OR length(trim(value)) = 0
    );
END;

CREATE TRIGGER books_touch_updated_at
AFTER UPDATE OF title, authors, isbn, publishedYear, genre, totalCopies, isArchived ON books
BEGIN
  UPDATE books SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER readers_touch_updated_at
AFTER UPDATE OF fullName, email, registrationNumber, status ON readers
BEGIN
  UPDATE readers SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
