# Northstar Payroll

A full-stack employee payroll management demo using React/Vite, Express, MySQL/Sequelize, and a Python payroll engine. It includes role-managed accounts (admin, HR, payroll manager, department manager, employee), scoped employee self-service, payroll approvals, SMTP/in-app notifications, leave requests, CSV employee import, effective-dated salary revisions, audit history, TOTP two-factor authentication, configurable currency/locale, and admin database backup/restore.

## Prerequisites
- Node.js 20+ and npm
- Python 3.10+
- MySQL 8+

## Setup
1. Create a MySQL database and import `database.sql`.
2. Copy `backend/.env.example` to `backend/.env`, then set database credentials and a strong `JWT_SECRET`. Do not copy real passwords into any `.env.example` file or commit `backend/.env`.
3. Install dependencies: `npm install`, `npm --prefix backend install`, `npm --prefix frontend install`, and `python -m pip install -r python_service/requirements.txt`. In Windows PowerShell, if the `npm` command is blocked by script execution policy, use `npm.cmd` in place of `npm` (for example, `npm.cmd install`, `npm.cmd --prefix backend install`, and `npm.cmd --prefix frontend install`).
4. Start both web and API processes with `npm run dev` from the project root. In Windows PowerShell, use `npm.cmd run dev` if the `npm` PowerShell shim is blocked. Frontend: `http://localhost:5173`; API: `http://localhost:4000/api`.
5. Register the first admin from the Register screen. After the first admin is created, public registration closes. Add employees from the Employees screen to create their linked employee logins; create HR, payroll manager, and department manager accounts from Workspace Tools. The API can optionally seed demo departments/employees/salary structures: run `npm --prefix backend run seed`.

The backend applies the additive role/2FA/payroll-approval migration and then synchronizes new Sequelize models on startup (`DB_SYNC=true` by default). SQL schema and five sample employees/payroll records are also provided in `database.sql`. Do not use demo credentials or the default secret in production. Configure `PYTHON_EXECUTABLE` if the `python` command is not available under that name. PDF creation uses ReportLab. SMTP notifications require `SMTP_HOST`, `SMTP_FROM`, and (where required) SMTP credentials. Database backup/restore requires `mysqldump` and `mysql` command-line clients; set `MYSQLDUMP_PATH` and `MYSQL_PATH` if they are not on PATH. Restore replaces data and should only be performed by an administrator after making a backup.

The backend's runtime email/upload/CSV packages are kept on patched releases. `npm audit` currently reports a moderate transitive `uuid` advisory through Sequelize 6; do not use `npm audit fix --force` because npm proposes downgrading Sequelize to an incompatible major version.

## Project structure
- `frontend/` React single-page application
- `backend/` Express REST API, Sequelize models, JWT middleware, Python bridge, seed script
- `python_service/` payroll calculations, reporting, and PDF service
- `database.sql` MySQL schema and five sample employees/payrolls
- `API.md` endpoint overview

## Main workflows
Register/login as administrator, create employees and departments, define each employee's salary, record attendance, then generate payroll for a month. Only administrators can add employees; each new employee automatically gets a linked login using their work email. The generated temporary password is shown once to the administrator and must be changed on the employee's first login. Share it securely. Employee accounts can view only their own dashboard, salary components, attendance, leave, and payslips. Payroll generation prevents duplicate employee/month/year records, factors unpaid leave and overtime, and delegates calculations to Python. Mark payroll paid from Payroll History; open a payslip to print or download its PDF. Reports can be filtered and exported as CSV.
Payroll begins in a separate approval state; use the Payroll approvals screen before marking a record paid. Approved unpaid leave weekdays are considered by payroll. Locale settings control monetary display and PDF currency; tax jurisdiction is metadata only, and statutory tax calculations must be configured/reviewed for the applicable country before real payroll use. Enable authenticator-based 2FA from Workspace Tools → Two-factor security.
