CREATE TABLE books (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  authors TEXT[] NOT NULL CHECK (cardinality(authors) > 0),
  isbn VARCHAR(20) NOT NULL UNIQUE CHECK (btrim(isbn) <> ''),
  publication_year INTEGER,
  genre TEXT,
  total_copies INTEGER NOT NULL DEFAULT 0 CHECK (total_copies >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE readers (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (btrim(full_name) <> ''),
  email TEXT NOT NULL CHECK (btrim(email) <> ''),
  registration_number TEXT NOT NULL UNIQUE CHECK (btrim(registration_number) <> ''),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX readers_email_lower_key ON readers (lower(email));

CREATE TABLE loans (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  reader_id BIGINT NOT NULL REFERENCES readers(id) ON DELETE RESTRICT,
  loaned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_date DATE NOT NULL,
  returned_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'overdue', 'returned')),
  fine_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fine_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX loans_book_id_idx ON loans (book_id);
CREATE INDEX loans_reader_id_idx ON loans (reader_id);
CREATE INDEX loans_unreturned_due_date_idx ON loans (due_date) WHERE returned_at IS NULL;
CREATE INDEX loans_loaned_at_idx ON loans (loaned_at);
