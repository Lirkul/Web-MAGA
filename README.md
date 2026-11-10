# Система управления библиотечным фондом

Серверное REST API на Node.js и Express. На текущем этапе настроено подключение к PostgreSQL 16 и реализована проверка состояния приложения и БД. Таблицы и миграции пока отсутствуют.

## Запуск через Docker Compose

Нужен работающий Docker Engine с Docker Compose. Из корня проекта выполните:

```sh
docker compose up --build -d
docker compose ps
curl -i http://localhost:3000/api/health
```

Для запуска с выводом логов используйте `docker compose up --build`. Эквивалентная команда старой версии Compose — `docker-compose up --build`.

Compose запускает `db` (PostgreSQL 16) и `api`. API ожидает успешного healthcheck БД и подключается к ней по имени `db`. Данные сохраняются в томе `postgres_data` между перезапусками. Остановка: `docker compose down` (без удаления тома).

Демонстрационные настройки работают без `.env`. Для изменения настроек скопируйте `.env.example` в `.env`. Не используйте демонстрационный пароль для реальных данных. При изменении пароля в `.env` учитывайте: PostgreSQL применяет начальные настройки только к пустому тому.

## Локальный запуск

Нужны Node.js 24 LTS и доступная PostgreSQL 16. Можно запустить только БД командой `docker compose up -d db`, затем:

```sh
cp .env.example .env
npm ci
npm start
```

В PowerShell файл копируется командой `Copy-Item .env.example .env`. Если выполнение `npm.ps1` запрещено, используйте `npm.cmd` вместо `npm`.

`npm start` и `npm run dev` читают `.env` штатными средствами Node.js. Уже заданные переменные окружения имеют приоритет. `npm run dev` включает штатный режим `node --watch`. Перед локальным запуском остановите контейнер API командой `docker compose stop api`, чтобы освободить порт 3000.

| Переменная | Демонстрационное значение | Назначение |
| --- | --- | --- |
| `PORT` | `3000` | Порт локального сервера; в Compose — внешний порт API |
| `DATABASE_URL` | `postgresql://web_maga:demo_password@localhost:5432/web_maga` | Подключение локального приложения к БД |
| `POSTGRES_DB` | `web_maga` | Имя БД в Compose |
| `POSTGRES_USER` | `web_maga` | Пользователь БД в Compose |
| `POSTGRES_PASSWORD` | `demo_password` | Демонстрационный пароль БД в Compose |

В контейнере API `DATABASE_URL` формируется из `POSTGRES_*` с хостом `db`, независимо от локального `DATABASE_URL`. Для специальных символов в имени пользователя или пароле требуется URL-кодирование в строке подключения. Порт БД 5432 опубликован только на `127.0.0.1` для локального запуска приложения.

## Проверка состояния

`GET /api/health` выполняет `SELECT 1` через пул соединений:

- Доступная БД: HTTP 200, `{"status":"ok","database":"connected"}`.
- Недоступная БД: HTTP 503, `{"status":"error","database":"disconnected"}`.

Ответ не содержит строку подключения и внутренние ошибки БД.

Воспроизводимая проверка отключения БД и восстановления:

```sh
docker compose stop db
curl -i http://localhost:3000/api/health
docker compose start db
curl -i http://localhost:3000/api/health
docker compose up --build -d
```

После `start db` дождитесь готовности БД (`docker compose ps`), затем проверьте HTTP 200. Проверка синтаксиса: `node --check src/app.js`, `node --check src/server.js`, `node --check src/db/pool.js`.
