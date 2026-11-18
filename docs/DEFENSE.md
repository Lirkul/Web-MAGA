# Защита Web-MAGA: 5–7 минут

Команды выполняются в PowerShell из корня репозитория на учебной БД. Docker Desktop должен работать; образы лучше собрать до защиты. Демонстрация создаёт книги, читателя и историю выдач. Ниже SQL меняет дату только одной демонстрационной выдачи, чтобы не ждать две недели. Секреты из `.env` показывать не нужно.

## 1. Запуск и состояние — 0:00–0:45

```powershell
docker compose up --build -d
docker compose ps
$api = 'http://localhost:3000/api'
$json = 'application/json; charset=utf-8'
Invoke-RestMethod "$api/health"
```

Ожидается: `db` имеет статус `healthy`, API работает, health возвращает `status: ok`, `database: connected`. Миграции запускаются автоматически; данные сохраняются в томе. Эквивалент старой команды: `docker-compose up --build -d`.

## 2. Swagger — 0:45–1:00

Открыть [http://localhost:3000/docs](http://localhost:3000/docs). Показать группы Books, Readers, Loans, Statistics, Health и выполнить health через **Execute**. Остальные запросы ниже можно повторить через Swagger.

## 3. Книга и читатель — 1:00–2:00

При первом запуске создаётся книга (201). Для повторного показа берётся ранее созданная книга по ISBN; читатель каждый раз новый.

```powershell
$book = (Invoke-RestMethod "$api/books?search=9780201616224").data | Where-Object isbn -eq '9780201616224' | Select-Object -First 1
if ($null -eq $book) {
    $book = Invoke-RestMethod -Method Post -Uri "$api/books" -ContentType $json -Body (@{
        title = 'Defense book'; authors = @('Demo author'); isbn = '9780201616224'; totalCopies = 2
    } | ConvertTo-Json)
}
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$reader = Invoke-RestMethod -Method Post -Uri "$api/readers" -ContentType $json -Body (@{
    fullName = 'Demo Reader'; email = "defense-$tag@example.com"; registrationNumber = "DEF-$tag"
} | ConvertTo-Json)
$book
$reader
```

Показать ID, `availableCopies`, начальный статус читателя `active`. При повторной регистрации того же email/номера API возвращает 409.

## 4. Выдача и возврат вовремя — 2:00–2:45

```powershell
$body = @{ bookId = $book.id; readerId = $reader.id } | ConvertTo-Json
$loan = Invoke-RestMethod -Method Post -Uri "$api/loans" -ContentType $json -Body $body
$loan
Invoke-RestMethod "$api/books/$($book.id)"
Invoke-RestMethod -Method Post -Uri "$api/loans/$($loan.id)/return"
```

Выдача — 201, `dueDate` по умолчанию через 14 дней UTC (`DEFAULT_LOAN_DAYS`); можно передать свою будущую дату. Остаток уменьшается и восстанавливается после возврата. Возврат — 200, `status: returned`, `fineAmount: "0.00"`. Повторный возврат — 409.

## 5. Просрочка и штраф — 2:45–4:00

Создать вторую выдачу и подготовить учебный пример: выдана 16 дней назад, срок закончился два дня назад. Имена пользователя и БД берутся из Compose без вывода пароля.

```powershell
$late = Invoke-RestMethod -Method Post -Uri "$api/loans" -ContentType $json -Body $body
$config = docker compose config --format json | ConvertFrom-Json
$dbUser = $config.services.db.environment.POSTGRES_USER
$dbName = $config.services.db.environment.POSTGRES_DB
docker compose exec -T db psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -c "UPDATE loans SET loaned_at = clock_timestamp() - INTERVAL '16 days', due_date = (clock_timestamp() AT TIME ZONE 'UTC')::date - 2 WHERE id = $($late.id) AND reader_id = $($reader.id) AND returned_at IS NULL;"
Invoke-RestMethod "$api/loans/$($late.id)"
Invoke-RestMethod "$api/statistics/overdue-readers" | ConvertTo-Json -Depth 6
```

Пока сохранённый статус `active`, статистика уже показывает книгу, `dueDate` и `daysOverdue: 2`: просрочка определяется по дате, без ожидания cron.

## 6. Ручной cron и возврат со штрафом — 4:00–4:45

```powershell
docker compose exec -T api npm run overdue:check
Invoke-RestMethod "$api/loans/$($late.id)"
Invoke-RestMethod -Method Post -Uri "$api/loans/$($late.id)/return"
docker compose exec -T api npm run overdue:check
```

После проверки статус — `overdue`; при возврате — `returned`, штраф при `FINE_PER_DAY=10` равен **20 рублям** (`"20.00"`). Повторная проверка не меняет возвращённую выдачу. Автоматическое расписание — ежедневно 00:05 UTC; npm-команда вызывает ту же сервисную функцию.

## 7. История и статистика — 4:45–5:30

```powershell
$from = [DateTime]::UtcNow.AddDays(-30).ToString('yyyy-MM-dd')
$to = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
Invoke-RestMethod "$api/loans?readerId=$($reader.id)" | ConvertTo-Json -Depth 5
Invoke-RestMethod "$api/statistics/top-books?from=$from&to=$to" | ConvertTo-Json -Depth 5
Invoke-RestMethod "$api/statistics/overdue-readers" | ConvertTo-Json -Depth 6
```

История сохраняет обе выдачи. Топ считает выдачи за период включительно, в том числе возвращённые; при равенстве сортирует по названию. У этого читателя текущих просрочек больше нет. Совместимые адреса `/api/stats/...` продолжают работать. Удаление книги или читателя с историей возвращает 409.

## 8. CSV — 5:30–6:30

```powershell
curl.exe -sS -X POST "$api/books/import" -F "file=@samples/books.csv"
curl.exe -sS -X POST "$api/books/import" -F "file=@samples/books.csv"
Invoke-RestMethod "$api/books?limit=100" | ConvertTo-Json -Depth 5
```

Файл содержит две книги. Первая загрузка импортирует отсутствующие ISBN, повторная возвращает `duplicates: 2`, `imported: 0`. При ранее выполненном seed оба запроса могут пропустить существующие книги. В Swagger для того же запроса выбрать `samples/books.csv` в поле `file`.

Кратко объяснить: `busboy` пишет поток во временный файл с лимитом 10 МиБ; `createReadStream` и `csv-parse` читают его блоками; цикл ждёт INSERT каждой записи, обеспечивая backpressure. Ошибочные строки пропускаются, в памяти остаются только счётчики, буферы и первые 20 ошибок. Временный файл удаляется в `finally`.

## Ответы на частые вопросы

- Архитектура: routes/controllers → services → repositories → PostgreSQL; ORM и фронтенда нет.
- Последний экземпляр защищён транзакцией и `SELECT ... FOR UPDATE` строки книги; возврат тоже блокирует строку выдачи.
- `availableCopies` вычисляется SQL по невозвращённым выдачам и отдельно не хранится.
- Сроки и просрочки считаются календарными датами UTC; штраф рассчитывается PostgreSQL NUMERIC при возврате.
- Проверки: `npm test` с отдельной БД `_test`; сценарии создают свои схемы и удаляют их. Для демонстрационного наполнения есть повторяемая `npm run db:seed`.
