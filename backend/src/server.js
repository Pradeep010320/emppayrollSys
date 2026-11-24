require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { Op, fn, col, literal } = require('sequelize');
const { sequelize, Admin, Department, Employee, Attendance, Salary, Payroll, Payslip, ActivityLog, SalaryRevision, CompanySetting } = require('./models');
const { requireAdmin, requireRoles } = require('./middleware/auth');
const { runPython } = require('./services/python');
const { createEmployeeWithLogin } = require('./services/employeeAccounts');
const payrollRouter = require('./routes/payroll');
const featuresRouter = require('./routes/features');
const { migrate } = require('./config/migrate');

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
const asyncRoute = fnc => (req, res, next) => Promise.resolve(fnc(req, res, next)).catch(next);
const logActivity = (req, action, type, id, details = {}) => ActivityLog.create({ adminId: req.admin?.id, action, entityType: type, entityId: id, details }).catch(() => {});
const includeEmployee = [{ model: Employee, include: [Department] }];
const csvCell = value => { const text = String(value ?? ''); const safe = typeof value === 'string' && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"`; };

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  if (await Admin.count() > 0) return res.status(403).json({ error: 'Public registration is closed. Ask a workspace administrator to create your account.' });
  const { fullName, email, password } = req.body;
  if (!fullName?.trim() || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, valid email, and a password of at least 8 characters are required.' });
  const existing = await Admin.findOne({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
  const admin = await Admin.create({ fullName: fullName.trim(), email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12) });
  const token = jwt.sign({ id: admin.id, employeeId: admin.employeeId, email: admin.email, fullName: admin.fullName, role: admin.role, mustChangePassword: false }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  res.status(201).json({ token, admin: { id: admin.id, fullName: admin.fullName, email: admin.email, role: admin.role, mustChangePassword: false } });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const admin = await Admin.findOne({ where: { email: String(req.body.email || '').toLowerCase() } });
  if (!admin || !(await bcrypt.compare(req.body.password || '', admin.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (admin.twoFactorEnabled && !speakeasy.totp.verify({ secret: admin.twoFactorSecret, encoding: 'base32', token: String(req.body.otp || ''), window: 1 })) return res.status(401).json({ error: 'A valid authenticator code is required.' });
  const token = jwt.sign({ id: admin.id, employeeId: admin.employeeId, email: admin.email, fullName: admin.fullName, role: admin.role, mfa: Boolean(admin.twoFactorEnabled), mustChangePassword: admin.mustChangePassword }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  res.json({ token, admin: { id: admin.id, fullName: admin.fullName, email: admin.email, role: admin.role, mustChangePassword: admin.mustChangePassword } });
}));
app.use('/api', requireAdmin);
app.use('/api', featuresRouter);
app.get('/api/auth/2fa/status', asyncRoute(async (req, res) => { const user = await Admin.findByPk(req.admin.id); res.json({ enabled: Boolean(user?.twoFactorEnabled) }); }));
app.post('/api/auth/2fa/setup', asyncRoute(async (req, res) => {
  const user = await Admin.findByPk(req.admin.id);
  const secret = speakeasy.generateSecret({ name: `Northstar Payroll (${user.email})`, length: 20 });
  user.twoFactorSecret = secret.base32; user.twoFactorEnabled = false; await user.save();
  res.json({ secret: secret.base32, qrDataUrl: await QRCode.toDataURL(secret.otpauth_url) });
}));
app.post('/api/auth/2fa/confirm', asyncRoute(async (req, res) => {
  const user = await Admin.findByPk(req.admin.id);
  if (!user?.twoFactorSecret || !speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token: String(req.body.otp || ''), window: 1 })) return res.status(400).json({ error: 'Authenticator code did not validate. Scan the latest QR code and retry.' });
  user.twoFactorEnabled = true; await user.save(); res.json({ enabled: true });
}));
app.post('/api/auth/2fa/disable', asyncRoute(async (req, res) => {
  const user = await Admin.findByPk(req.admin.id);
  if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash)) || !speakeasy.totp.verify({ secret: user.twoFactorSecret || '', encoding: 'base32', token: String(req.body.otp || ''), window: 1 })) return res.status(400).json({ error: 'Password and current authenticator code must match.' });
  user.twoFactorEnabled = false; user.twoFactorSecret = null; await user.save(); res.json({ enabled: false });
}));
app.get('/api/me/profile', asyncRoute(async (req, res) => {
  if (!req.admin.employeeId) return res.status(404).json({ error: 'This account is not linked to an employee profile.' });
  const employee = await Employee.findByPk(req.admin.employeeId, { include: [Department, Salary] });
  if (!employee) return res.status(404).json({ error: 'Employee profile not found.' });
  res.json(employee);
}));
app.get('/api/me/payslips', asyncRoute(async (req, res) => {
  if (!req.admin.employeeId) return res.status(404).json({ error: 'This account is not linked to an employee profile.' });
  res.json(await Payroll.findAll({ where: { employeeId: req.admin.employeeId }, order: [['year', 'DESC'], ['month', 'DESC']] }));
}));
app.get('/api/me/attendance', asyncRoute(async (req, res) => {
  if (!req.admin.employeeId) return res.status(404).json({ error: 'This account is not linked to an employee profile.' });
  res.json(await Attendance.findAll({ where: { employeeId: req.admin.employeeId }, order: [['attendanceDate', 'DESC']], limit: 500 }));
}));
app.get('/api/auth/me', asyncRoute(async (req, res) => {
  const admin = await Admin.findByPk(req.admin.id, { attributes: ['id', 'fullName', 'email', 'role', 'employeeId', 'mustChangePassword', 'twoFactorEnabled', 'createdAt'] });
  if (!admin) return res.status(404).json({ error: 'Admin not found.' });
  res.json(admin);
}));
app.put('/api/auth/me', asyncRoute(async (req, res) => {
  const admin = await Admin.findByPk(req.admin.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found.' });
  if (admin.mustChangePassword && !req.body.password) return res.status(400).json({ error: 'Set a new password before continuing.' });
  if (req.body.fullName?.trim()) admin.fullName = req.body.fullName.trim();
  if (req.body.email) admin.email = req.body.email.toLowerCase();
  let token;
  if (req.body.password) {
    if (req.body.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (admin.mustChangePassword && await bcrypt.compare(req.body.password, admin.passwordHash)) return res.status(400).json({ error: 'Choose a password different from your temporary password.' });
    admin.passwordHash = await bcrypt.hash(req.body.password, 12);
    admin.mustChangePassword = false;
  }
  await admin.save();
  if (req.body.password) {
    token = jwt.sign({ id: admin.id, employeeId: admin.employeeId, email: admin.email, fullName: admin.fullName, role: admin.role, mfa: Boolean(admin.twoFactorEnabled), mustChangePassword: false }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  }
  res.json({ id: admin.id, fullName: admin.fullName, email: admin.email, role: admin.role, mustChangePassword: admin.mustChangePassword, ...(token ? { token } : {}) });
}));

// Employee CRUD with search, filters, and bounded pagination.
app.get('/api/employees', asyncRoute(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const where = {};
  if (req.query.q) where[Op.or] = ['fullName', 'email', 'employeeId', 'designation'].map(k => ({ [k]: { [Op.like]: `%${req.query.q}%` } }));
  if (req.query.departmentId) where.departmentId = req.query.departmentId;
  if (req.query.status) where.employmentStatus = req.query.status;
      if (req.admin.role === 'department_manager') {
        const manager = await Employee.findByPk(req.admin.employeeId);
        if (!manager?.departmentId) return res.status(403).json({ error: 'Link this manager account to an employee in their department.' });
        where.departmentId = manager.departmentId;
      } else if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Employee records are restricted to HR and department managers.' });
  const result = await Employee.findAndCountAll({ where, include: [Department], order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit });
  res.json({ rows: result.rows, count: result.count, page, pages: Math.ceil(result.count / limit) });
}));
app.get('/api/employees/:id', asyncRoute(async (req, res) => {
  const item = await Employee.findByPk(req.params.id, { include: [Department, Salary, Payroll] });
  if (req.admin.role === 'department_manager') {
    const manager = await Employee.findByPk(req.admin.employeeId);
    if (!manager?.departmentId || item?.departmentId !== manager.departmentId) return res.status(403).json({ error: 'You can only view employees in your department.' });
  } else if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Employee records are restricted to HR and department managers.' });
  if (!item) return res.status(404).json({ error: 'Employee not found.' }); res.json(item);
}));
app.post('/api/employees', asyncRoute(async (req, res) => {
  if (req.admin.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can add employees.' });
  const { employee, credentials } = await createEmployeeWithLogin(req.body);
  await logActivity(req, 'created employee and login', 'employee', employee.id, { employeeId: employee.employeeId, loginId: credentials.loginId });
  res.status(201).json({ employee, credentials });
}));
app.put('/api/employees/:id', asyncRoute(async (req, res) => {
  if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can update employees.' });
  const item = await Employee.findByPk(req.params.id);
  if (!item) return res.status(404).json({ error: 'Employee not found.' });
  const editable = ['fullName','email','phone','gender','dateOfBirth','departmentId','designation','joiningDate','address','bankAccountNumber','ifscCode','panNumber','employmentStatus'];
  const changes = Object.fromEntries(editable.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
  if (changes.fullName !== undefined) changes.fullName = String(changes.fullName).trim();
  if (changes.email !== undefined) changes.email = String(changes.email).trim().toLowerCase();
  const linkedAccount = await Admin.findOne({ where: { employeeId: item.id, role: 'employee' } });
  if (changes.email && changes.email !== item.email.toLowerCase()) {
    const employeeConflict = await Employee.findOne({ where: { email: changes.email, id: { [Op.ne]: item.id } } });
    const accountConflict = await Admin.findOne({ where: { email: changes.email, ...(linkedAccount ? { id: { [Op.ne]: linkedAccount.id } } : {}) } });
    if (employeeConflict || accountConflict) return res.status(409).json({ error: 'Another employee or account already uses this email.' });
  }
  await sequelize.transaction(async transaction => {
    await item.update(changes, { transaction });
    if (linkedAccount) {
      const accountChanges = {};
      if (changes.fullName !== undefined) accountChanges.fullName = changes.fullName;
      if (changes.email !== undefined) accountChanges.email = changes.email;
      if (Object.keys(accountChanges).length) await linkedAccount.update(accountChanges, { transaction });
    }
  });
  await logActivity(req, 'updated', 'employee', item.id); res.json(item);
}));
app.delete('/api/employees/:id', asyncRoute(async (req, res) => {
    if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can delete employees.' });
  const item = await Employee.findByPk(req.params.id); if (!item) return res.status(404).json({ error: 'Employee not found.' });
  await sequelize.transaction(async transaction => {
    await Admin.destroy({ where: { employeeId: item.id, role: 'employee' }, transaction });
    await item.destroy({ transaction });
  });
  await logActivity(req, 'deleted', 'employee', item.id); res.status(204).end();
}));

app.get('/api/departments', asyncRoute(async (req, res) => res.json(await Department.findAll({ include: [{ model: Employee, attributes: ['id'] }], order: [['departmentName','ASC']] }))));
app.post('/api/departments', asyncRoute(async (req, res) => {
  if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can manage departments.' });
  if (!req.body.departmentName?.trim()) return res.status(400).json({ error: 'Department name is required.' });
  const item = await Department.create({ ...req.body, departmentId: `DEP-${Date.now().toString().slice(-7)}` }); await logActivity(req, 'created', 'department', item.id); res.status(201).json(item);
}));
app.put('/api/departments/:id', asyncRoute(async (req, res) => {
    if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can manage departments.' });
  const item = await Department.findByPk(req.params.id); if (!item) return res.status(404).json({ error: 'Department not found.' });
  for (const key of ['departmentName','description','managerName']) if (req.body[key] !== undefined) item[key] = req.body[key]; await item.save(); await logActivity(req, 'updated', 'department', item.id); res.json(item);
}));
app.delete('/api/departments/:id', asyncRoute(async (req, res) => {
    if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can manage departments.' });
  const item = await Department.findByPk(req.params.id); if (!item) return res.status(404).json({ error: 'Department not found.' }); await item.destroy(); await logActivity(req, 'deleted', 'department', item.id); res.status(204).end();
}));

app.get('/api/attendance', asyncRoute(async (req, res) => {
  const where = {};
  if (req.admin.role === 'employee') {
    if (!req.admin.employeeId) return res.status(403).json({ error: 'This account is not linked to an employee profile.' });
    where.employeeId = req.admin.employeeId;
  } else if (req.admin.role === 'department_manager') {
    const manager = await Employee.findByPk(req.admin.employeeId);
    if (!manager?.departmentId) return res.status(403).json({ error: 'Link this manager account to a department employee profile.' });
    const team = await Employee.findAll({ where: { departmentId: manager.departmentId }, attributes: ['id'] });
    where.employeeId = { [Op.in]: team.map(employee => employee.id) };
  } else if (req.query.employeeId) where.employeeId = req.query.employeeId;
  if (!['admin', 'hr', 'department_manager', 'employee'].includes(req.admin.role)) return res.status(403).json({ error: 'Attendance access is restricted.' });
  if (req.query.month && req.query.year) {
    const start = new Date(Date.UTC(Number(req.query.year), Number(req.query.month) - 1, 1)).toISOString().slice(0,10);
    const end = new Date(Date.UTC(Number(req.query.year), Number(req.query.month), 1)).toISOString().slice(0,10);
    where.attendanceDate = { [Op.gte]: start, [Op.lt]: end };
  }
  res.json(await Attendance.findAll({ where, include: [{ model: Employee, attributes: ['id','employeeId','fullName'] }], order: [['attendanceDate','DESC']], limit: 500 }));
}));
app.post('/api/attendance', asyncRoute(async (req, res) => {
    if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can record attendance.' });
  const { employeeId, attendanceDate, status } = req.body;
  if (!employeeId || !attendanceDate || !['Present','Absent','Paid Leave','Unpaid Leave'].includes(status)) return res.status(400).json({ error: 'Employee, date, and a valid attendance status are required.' });
  const [item, created] = await Attendance.findOrCreate({ where: { employeeId, attendanceDate }, defaults: req.body });
  if (!created) { await item.update(req.body); }
  await logActivity(req, created ? 'recorded' : 'updated', 'attendance', item.id);
  res.status(created ? 201 : 200).json(item);
}));
app.put('/api/attendance/:id', asyncRoute(async (req, res) => {
    if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can update attendance.' });
  const item = await Attendance.findByPk(req.params.id); if (!item) return res.status(404).json({ error: 'Attendance record not found.' }); await item.update(req.body); await logActivity(req, 'updated', 'attendance', item.id); res.json(item);
}));
app.delete('/api/attendance/:id', asyncRoute(async (req, res) => { if (!['admin', 'hr'].includes(req.admin.role)) return res.status(403).json({ error: 'Only HR can delete attendance.' }); const n = await Attendance.destroy({ where: { id: req.params.id } }); if (!n) return res.status(404).json({ error: 'Attendance record not found.' }); res.status(204).end(); }));

app.get('/api/salary', asyncRoute(async (req, res) => {
    if (!['admin', 'hr', 'payroll_manager'].includes(req.admin.role)) return res.status(403).json({ error: 'Salary details are restricted to HR and payroll managers.' });
  const where = req.query.employeeId ? { employeeId: req.query.employeeId } : {};
  res.json(await Salary.findAll({ where, include: [{ model: Employee, attributes: ['id','employeeId','fullName'] }] }));
}));
app.post('/api/salary', asyncRoute(async (req, res) => {
    if (!['admin', 'payroll_manager'].includes(req.admin.role)) return res.status(403).json({ error: 'Only payroll managers can change salary structures.' });
  if (!req.body.employeeId) return res.status(400).json({ error: 'Employee is required.' });
  const employeeId = Number(req.body.employeeId);
  const effectiveDate = req.body.effectiveDate || new Date().toISOString().slice(0, 10);
  const reason = req.body.reason || 'Compensation update';
  const editable = ['basicSalary','hra','allowances','bonus','overtimeRate','providentFund','professionalTax','incomeTax','otherDeductions'];
  const changes = Object.fromEntries(editable.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
  const current = await Salary.findOne({ where: { employeeId } });
  if (current) await SalaryRevision.create({ employeeId, effectiveDate, reason, snapshot: current.toJSON() });
  const [item] = await Salary.findOrCreate({ where: { employeeId }, defaults: changes });
  if (current) await item.update(changes);
  else await SalaryRevision.create({ employeeId, effectiveDate, reason: 'Initial salary structure', snapshot: item.toJSON() });
  await logActivity(req, 'updated salary structure', 'salary', item.id, { employeeId, effectiveDate, reason });
  res.status(current ? 200 : 201).json(item);
}));
app.put('/api/salary/:id', asyncRoute(async (req, res) => {
    if (!['admin', 'payroll_manager'].includes(req.admin.role)) return res.status(403).json({ error: 'Only payroll managers can change salary structures.' });
  const item = await Salary.findByPk(req.params.id); if (!item) return res.status(404).json({ error: 'Salary structure not found.' }); await item.update(req.body); res.json(item);
}));
app.delete('/api/salary/:id', asyncRoute(async (req, res) => { const n = await Salary.destroy({ where: { id: req.params.id } }); if (!n) return res.status(404).json({ error: 'Salary structure not found.' }); res.status(204).end(); }));
app.delete('/api/salary/:id', asyncRoute(async (req, res) => { if (!['admin', 'payroll_manager'].includes(req.admin.role)) return res.status(403).json({ error: 'Only payroll managers can change salary structures.' }); const n = await Salary.destroy({ where: { id: req.params.id } }); if (!n) return res.status(404).json({ error: 'Salary structure not found.' }); res.status(204).end(); }));

app.use('/api/payroll', payrollRouter);

app.get('/api/payslips/:payrollId', asyncRoute(async (req, res) => {
  const item = await Payroll.findByPk(req.params.payrollId, { include: includeEmployee }); if (!item) return res.status(404).json({ error: 'Payslip not found.' });
  if (req.admin.role === 'employee' && item.employeeId !== req.admin.employeeId) return res.status(403).json({ error: 'You can only view your own payslips.' });
  if (req.admin.role === 'department_manager') { const manager = await Employee.findByPk(req.admin.employeeId); if (!manager?.departmentId || item.Employee?.departmentId !== manager.departmentId) return res.status(403).json({ error: 'You can only view payslips for employees in your department.' }); }
  if (!['admin','hr','payroll_manager','department_manager','employee'].includes(req.admin.role)) return res.status(403).json({ error: 'Payslip access is restricted.' });
  const companySetting = await CompanySetting.findOne({ where: { key: 'company' } }); const company = companySetting?.value || {};
  res.json({ company: { name: company.companyName || process.env.COMPANY_NAME || 'Northstar Systems', address: company.companyAddress || process.env.COMPANY_ADDRESS || '', currency: company.currency || 'USD' }, payroll: item });
}));
app.get('/api/payslips/:payrollId/pdf', asyncRoute(async (req, res) => {
  const item = await Payroll.findByPk(req.params.payrollId, { include: includeEmployee }); if (!item) return res.status(404).json({ error: 'Payslip not found.' });
  if (req.admin.role === 'employee' && item.employeeId !== req.admin.employeeId) return res.status(403).json({ error: 'You can only download your own payslips.' });
  if (req.admin.role === 'department_manager') { const manager = await Employee.findByPk(req.admin.employeeId); if (!manager?.departmentId || item.Employee?.departmentId !== manager.departmentId) return res.status(403).json({ error: 'You can only download payslips for employees in your department.' }); }
  if (!['admin','hr','payroll_manager','department_manager','employee'].includes(req.admin.role)) return res.status(403).json({ error: 'Payslip access is restricted.' });
  const companySetting = await CompanySetting.findOne({ where: { key: 'company' } }); const company = companySetting?.value || {};
  const result = await runPython({ action: 'payslip', company: { name: company.companyName || process.env.COMPANY_NAME || 'Northstar Systems', address: company.companyAddress || process.env.COMPANY_ADDRESS || '', currency: company.currency || 'USD' }, payroll: item.toJSON() });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename=payslip-${item.employeeId}-${item.year}-${String(item.month).padStart(2,'0')}.pdf`); res.send(Buffer.from(result.pdf_base64, 'base64'));
}));

app.use('/api/reports', requireRoles('admin', 'hr', 'payroll_manager'));
app.get('/api/reports/summary', asyncRoute(async (req, res) => {
  const [employeeCount, departmentCount, totalPending, totalPaid, payrollSum, recentEmployees, recentPayroll, departmentCounts] = await Promise.all([
    Employee.count({ where: { employmentStatus: 'Active' } }), Department.count(), Payroll.count({ where: { status: 'Pending' } }), Payroll.count({ where: { status: 'Paid' } }),
    Payroll.sum('netSalary', { where: { month: Number(req.query.month) || new Date().getMonth() + 1, year: Number(req.query.year) || new Date().getFullYear(), status: { [Op.ne]: 'Cancelled' } } }),
    Employee.findAll({ include: [Department], order: [['createdAt','DESC']], limit: 5 }), Payroll.findAll({ include: includeEmployee, order: [['createdAt','DESC']], limit: 5 }),
    Department.findAll({ attributes: ['departmentName', [fn('COUNT', col('Employees.id')), 'employeeCount']], include: [{ model: Employee, attributes: [], required: false }], group: ['Department.id'], raw: true })
  ]);
  const months = await Payroll.findAll({ attributes: ['month','year',[fn('SUM',col('net_salary')),'total']], where: { status: { [Op.ne]: 'Cancelled' } }, group: ['year','month'], order: [['year','ASC'],['month','ASC']], limit: 12, raw: true });
  res.json({ employeeCount, departmentCount, pendingCount: totalPending, paidCount: totalPaid, monthlyPayroll: Number(payrollSum || 0), recentEmployees, recentPayroll, departmentCounts, monthlyTrend: months });
}));
app.get('/api/reports/employees/:employeeId/salary-history', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.params.employeeId, { include: [Department] });
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  const history = await Payroll.findAll({ where: { employeeId: employee.id, status: { [Op.ne]: 'Cancelled' } }, order: [['year','DESC'],['month','DESC']] });
  res.json({ employee, history });
}));
app.get('/api/reports/payroll.csv', asyncRoute(async (req, res) => {
  const items = await Payroll.findAll({ where: req.query.year ? { year: req.query.year } : {}, include: includeEmployee, order: [['year','DESC'],['month','DESC']] });
  const result = await runPython({ action: 'report', rows: items.map(p => ({ employee_id: p.Employee?.employeeId, employee: p.Employee?.fullName, department: p.Employee?.Department?.departmentName, month: p.month, year: p.year, gross_salary: p.grossSalary, total_deductions: p.totalDeductions, net_salary: p.netSalary, status: p.status })) });
  res.type('text/csv').attachment('payroll-report.csv').send(result.csv);
}));
app.get('/api/reports/payroll.pdf', asyncRoute(async (req, res) => {
  const items = await Payroll.findAll({ where: req.query.year ? { year: req.query.year } : {}, include: includeEmployee, order: [['year','DESC'],['month','DESC']] });
  const rows = items.map(p => ({ employee_id: p.Employee?.employeeId, employee: p.Employee?.fullName, department: p.Employee?.Department?.departmentName, month: p.month, year: p.year, gross_salary: p.grossSalary, total_deductions: p.totalDeductions, net_salary: p.netSalary, status: p.status }));
  const result = await runPython({ action: 'report_pdf', company: { name: process.env.COMPANY_NAME || 'Northstar Systems' }, rows });
  res.type('application/pdf').attachment('payroll-report.pdf').send(Buffer.from(result.pdf_base64, 'base64'));
}));
app.get('/api/reports/department.csv', asyncRoute(async (req, res) => {
  const rows = await Department.findAll({ include: [{ model: Employee, include: [Payroll] }] });
  const lines = [['Department','Employees','Payroll records','Net payroll'], ...rows.map(d => [d.departmentName,d.Employees.length,d.Employees.reduce((n,e)=>n+e.Payrolls.length,0),d.Employees.reduce((n,e)=>n+e.Payrolls.reduce((s,p)=>s+Number(p.netSalary),0),0)])];
  res.type('text/csv').attachment('department-report.csv').send(lines.map(r=>r.map(csvCell).join(',')).join('\n'));
}));

app.use((req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A record with these unique details already exists.' });
  if (err.name === 'SequelizeValidationError') return res.status(400).json({ error: err.errors.map(e => e.message).join(', ') });
  res.status(err.message?.includes('Python') || err.message?.includes('ReportLab') ? 503 : 500).json({ error: err.message || 'Internal server error.' });
});

const port = Number(process.env.PORT || 4000);
(async () => {
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required. Copy backend/.env.example to backend/.env and configure it.');
    await sequelize.authenticate();
    await migrate(sequelize);
    if (process.env.DB_SYNC !== 'false') await sequelize.sync();
    app.listen(port, () => console.log(`Payroll API listening on http://localhost:${port}`));
  } catch (error) { console.error('Unable to start API:', error.message); process.exit(1); }
})();
