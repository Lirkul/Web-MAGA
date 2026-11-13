import * as statsRepository from '../repositories/stats.repository.js';

export async function getTopBooks(query) {
  const rows = await statsRepository.findTopBooks(query);
  return {
    period: { from: query.from, to: query.to },
    data: rows.map((row) => ({
      bookId: Number(row.book_id), title: row.title, authors: row.authors,
      isbn: row.isbn, loansCount: Number(row.loans_count),
    })),
  };
}

export async function getOverdueReaders(query) {
  const { rows, total } = await statsRepository.findOverdueReaders(query);
  return {
    data: rows.map((row) => ({
      readerId: Number(row.reader_id), fullName: row.full_name, email: row.email,
      registrationNumber: row.registration_number, status: row.status,
      overdueLoansCount: Number(row.overdue_loans_count), oldestDueDate: row.oldest_due_date,
      maxDaysOverdue: Number(row.max_days_overdue),
    })),
    pagination: {
      page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit),
    },
  };
}
