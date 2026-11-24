const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { Op } = require('sequelize');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Admin, ActivityLog, CompanySetting, Department, Employee, LeaveRequest, Notification, Payroll, Salary, SalaryRevision } = require('../models');
const { requireRoles } = require('../middleware/auth');
const { notifyAccount, notifyRoles } = require('../services/notifications');
const { createEmployeeWithLogin } = require('../services/employeeAccounts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const roles = { admin: ['admin'], hr: ['admin', 'hr'], payroll: ['admin', 'payroll_manager'], hrPayroll: ['admin', 'hr', 'payroll_manager'] };
const roleGate = allowed => (req, res, next) => requireRoles(...allowed)(req, res, next);
const publicAccount = user => ({ id: user.id, fullName: user.fullName, email: user.email, role: user.role, employeeId: user.employeeId, twoFactorEnabled: user.twoFactorEnabled });
const log = (adminId, action, entityType, entityId, details = {}) => ActivityLog.create({ adminId, action, entityType, entityId, details });
const validRoles = ['admin', 'hr', 'payroll_manager', 'department_manager', 'employee'];

// Admin-managed workspace accounts; public self-registration never accepts a role.
router.get('/users', roleGate(roles.admin), asyncRoute(async (req, res) => res.json((await Admin.findAll({ order: [['createdAt', 'DESC']] })).map(publicAccount))));
router.post('/users', roleGate(roles.admin), asyncRoute(async (req, res) => {
  const { fullName, email, password, role, employeeId } = req.body;
  if (!fullName?.trim() || !email || !password || password.length < 8 || !validRoles.includes(role)) return res.status(400).json({ error: 'Name, email, password (8+ characters), and a valid role are required.' });
  if (role === 'employee') return res.status(400).json({ error: 'Add the employee from the Employees page to create a linked login automatically.' });
  if (['employee', 'department_manager'].includes(role) && !employeeId) return res.status(400).json({ error: 'Choose the linked employee for this workspace role.' });
  const bcrypt = require('bcryptjs');
  const user = await Admin.create({ fullName: fullName.trim(), email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role, employeeId: employeeId || null });
  await log(req.admin.id, 'created account', 'user', user.id, { role });
  res.status(201).json(publicAccount(user));
}));
router.put('/users/:id', roleGate(roles.admin), asyncRoute(async (req, res) => {
  const user = await Admin.findByPk(req.params.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (user.id === req.admin.id && req.body.role && req.body.role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own administrator access.' });
  if (req.body.role && !validRoles.includes(req.body.role)) return res.status(400).json({ error: 'Choose a valid workspace role.' });
  if (req.body.role === 'employee' && user.role !== 'employee') return res.status(400).json({ error: 'Add the employee from the Employees page to create a linked login automatically.' });
  for (const key of ['fullName', 'role', 'employeeId']) if (req.body[key] !== undefined) user[key] = req.body[key];
  if (['employee', 'department_manager'].includes(user.role) && !user.employeeId) return res.status(400).json({ error: 'Link this role to an employee profile before saving.' });
  if (req.body.password) { if (req.body.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' }); user.passwordHash = await require('bcryptjs').hash(req.body.password, 12); if (user.role === 'employee') user.mustChangePassword = true; }
  await user.save(); await log(req.admin.id, 'updated account', 'user', user.id, { role: user.role }); res.json(publicAccount(user));
}));
router.delete('/users/:id', roleGate(roles.admin), asyncRoute(async (req, res) => {
  if (Number(req.params.id) === req.admin.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const user = await Admin.findByPk(req.params.id); if (!user) return res.status(404).json({ error: 'Account not found.' });
  await user.destroy(); await log(req.admin.id, 'deleted account', 'user', Number(req.params.id)); res.status(204).end();
}));

// Leave requests. Employee accounts can create and view only their own requests.
router.get('/leave', asyncRoute(async (req, res) => {
  const where = {};
  if (req.admin.role === 'employee') {
    if (!req.admin.employeeId) return res.status(403).json({ error: 'This employee account is not linked to an employee profile.' });
    where.employeeId = req.admin.employeeId;
  } else if (req.admin.role === 'department_manager') {
    const manager = await Employee.findByPk(req.admin.employeeId);
    if (!manager?.departmentId) return res.status(403).json({ error: 'Link this manager account to a department employee profile.' });
    const team = await Employee.findAll({ where: { departmentId: manager.departmentId }, attributes: ['id'] });
    where.employeeId = { [Op.in]: team.map(employee => employee.id) };
  } else if (req.query.status) where.status = req.query.status;
  res.json(await LeaveRequest.findAll({ where, include: [{ model: Employee, attributes: ['id', 'employeeId', 'fullName', 'departmentId'] }], order: [['createdAt', 'DESC']], limit: 500 }));
}));
router.post('/leave', asyncRoute(async (req, res) => {
  const employeeId = ['employee', 'department_manager'].includes(req.admin.role) ? req.admin.employeeId : Number(req.body.employeeId);
  if (req.admin.role === 'department_manager' && req.body.employeeId && Number(req.body.employeeId) !== req.admin.employeeId) return res.status(403).json({ error: 'Managers can submit leave requests only for themselves.' });
  const { startDate, endDate, leaveType, reason } = req.body;
  if (!employeeId || !startDate || !endDate || endDate < startDate || !['Paid', 'Unpaid', 'Sick', 'Personal'].includes(leaveType)) return res.status(400).json({ error: 'Choose an employee, valid date range, and leave type.' });
  const request = await LeaveRequest.create({ employeeId, startDate, endDate, leaveType, reason });
  await log(req.admin.id, 'requested leave', 'leave', request.id);
  await notifyRoles(roles.hr, { title: 'Leave request submitted', message: `A new ${leaveType.toLowerCase()} leave request needs review.`, category: 'leave', link: '/leave' });
  res.status(201).json(request);
}));
router.put('/leave/:id/review', asyncRoute(async (req, res) => {
  const request = await LeaveRequest.findByPk(req.params.id, { include: [Employee] });
  if (!request) return res.status(404).json({ error: 'Leave request not found.' });
  if (!roles.hr.includes(req.admin.role) && req.admin.role !== 'department_manager') return res.status(403).json({ error: 'Only HR or a department manager can review leave.' });
  if (req.admin.role === 'department_manager') {
    const manager = await Employee.findOne({ where: { id: req.admin.employeeId } });
    if (!manager || manager.departmentId !== request.Employee.departmentId) return res.status(403).json({ error: 'You can only review leave for your department.' });
  }
  if (!['Approved', 'Rejected'].includes(req.body.status)) return res.status(400).json({ error: 'Review status must be Approved or Rejected.' });
  request.status = req.body.status; request.reviewedBy = req.admin.id; request.reviewedAt = new Date(); request.reviewerNote = req.body.reviewerNote || null; await request.save();
  await log(req.admin.id, `leave ${request.status.toLowerCase()}`, 'leave', request.id);
  const employeeUser = await Admin.findOne({ where: { employeeId: request.employeeId, role: 'employee' } });
  if (employeeUser) await notifyAccount(employeeUser.id, { title: `Leave ${request.status.toLowerCase()}`, message: `Your leave request from ${request.startDate} to ${request.endDate} was ${request.status.toLowerCase()}.`, category: 'leave', link: '/leave' });
  res.json(request);
}));

// Salary changes are effective-dated and retain a JSON snapshot of each prior structure.
router.get('/salary-revisions/:employeeId', roleGate(roles.payroll), asyncRoute(async (req, res) => res.json(await SalaryRevision.findAll({ where: { employeeId: req.params.employeeId }, order: [['effectiveDate', 'DESC'], ['createdAt', 'DESC']] }))));
router.get('/audit', roleGate(roles.hr), asyncRoute(async (req, res) => {
  const where = {}; if (req.query.entityType) where.entityType = req.query.entityType;
  res.json(await ActivityLog.findAll({ where, include: [{ model: Admin, attributes: ['id', 'fullName', 'email', 'role'] }], order: [['createdAt', 'DESC']], limit: Math.min(500, Number(req.query.limit) || 150) }));
}));

// Durable in-app notifications, scoped to the signed-in account.
router.get('/notifications', asyncRoute(async (req, res) => res.json(await Notification.findAll({ where: { adminId: req.admin.id }, order: [['createdAt', 'DESC']], limit: 100 }))));
router.put('/notifications/:id/read', asyncRoute(async (req, res) => {
  const notification = await Notification.findOne({ where: { id: req.params.id, adminId: req.admin.id } });
  if (!notification) return res.status(404).json({ error: 'Notification not found.' });
  notification.readAt = new Date(); await notification.save(); res.json(notification);
}));
router.put('/notifications/read-all', asyncRoute(async (req, res) => { await Notification.update({ readAt: new Date() }, { where: { adminId: req.admin.id, readAt: null } }); res.json({ success: true }); }));

// Company locale and jurisdiction settings. Tax rules remain explicitly configured monetary amounts, not guessed legal advice.
router.get('/settings/company', asyncRoute(async (req, res) => {
  const setting = await CompanySetting.findOne({ where: { key: 'company' } });
  res.json(setting?.value || { currency: 'USD', locale: 'en-US', taxJurisdiction: 'US-CA', taxYear: new Date().getFullYear(), companyName: process.env.COMPANY_NAME || 'Northstar Systems', companyAddress: process.env.COMPANY_ADDRESS || '' });
}));
router.put('/settings/company', roleGate(roles.admin), asyncRoute(async (req, res) => {
  const value = { currency: String(req.body.currency || 'USD').toUpperCase(), locale: req.body.locale || 'en-US', taxJurisdiction: req.body.taxJurisdiction || '', taxYear: Number(req.body.taxYear) || new Date().getFullYear(), companyName: req.body.companyName || '', companyAddress: req.body.companyAddress || '' };
  if (!/^[A-Z]{3}$/.test(value.currency)) return res.status(400).json({ error: 'Currency must be a three-letter ISO code.' });
  const [setting] = await CompanySetting.findOrCreate({ where: { key: 'company' }, defaults: { value } });
  if (setting.value !== value) { setting.value = value; await setting.save(); }
  await log(req.admin.id, 'updated company payroll settings', 'settings', setting.id);
  res.json(setting.value);
}));

// CSV employee import with row-level feedback and spreadsheet formula protection.
router.post('/employees/import', roleGate(roles.admin), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a CSV file first.' });
  const records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: false });
  if (records.length > 1000) return res.status(413).json({ error: 'Import is limited to 1,000 rows per file.' });
  const results = [];
  for (let index = 0; index < records.length; index += 1) {
    const row = records[index];
    try {
      const fullName = row.full_name || row.fullName;
      const email = String(row.email || '').toLowerCase();
      if (!fullName || !email || !email.includes('@')) throw new Error('full_name and valid email are required');
      let departmentId = row.department_id || row.departmentId || null;
      if (!departmentId && row.department) departmentId = (await Department.findOne({ where: { departmentName: row.department } }))?.id || null;
      const { employee, credentials } = await createEmployeeWithLogin({
        employeeId: row.employee_id || row.employeeId,
        fullName,
        email,
        phone: row.phone,
        departmentId,
        designation: row.designation,
        joiningDate: row.joining_date || row.joiningDate,
        employmentStatus: row.employment_status || 'Active'
      });
      results.push({ row: index + 2, employeeId: employee.employeeId, status: 'imported', credentials });
    } catch (error) { results.push({ row: index + 2, status: 'error', error: error.message }); }
  }
  await log(req.admin.id, 'imported employees', 'employee', null, { count: results.filter(row => row.status === 'imported').length });
  res.json({ total: records.length, imported: results.filter(row => row.status === 'imported').length, failed: results.filter(row => row.status === 'error').length, rows: results });
}));

// Admin-only database backup download and explicitly confirmed SQL restore.
function mysqlEnvironment() { return { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' }; }
router.get('/backups/download', roleGate(roles.admin), (req, res, next) => {
  const executable = process.env.MYSQLDUMP_PATH || 'mysqldump';
  const child = spawn(executable, ['--host', process.env.DB_HOST || 'localhost', '--port', String(process.env.DB_PORT || 3306), '--user', process.env.DB_USER || 'root', '--single-transaction', '--routines', '--triggers', process.env.DB_NAME || 'payroll_db'], { env: mysqlEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  res.setHeader('Content-Type', 'application/sql'); res.setHeader('Content-Disposition', `attachment; filename=payroll-backup-${new Date().toISOString().slice(0, 10)}.sql`);
  child.stdout.pipe(res);
  child.on('error', error => { if (!res.headersSent) next(new Error(`Could not start mysqldump. Configure MYSQLDUMP_PATH: ${error.message}`)); else res.destroy(error); });
  child.on('close', code => { if (code !== 0) { if (!res.headersSent) next(new Error(stderr || 'Database backup failed.')); else res.destroy(new Error(stderr || 'Database backup failed.')); } });
});
router.post('/backups/restore', roleGate(roles.admin), upload.single('file'), asyncRoute(async (req, res) => {
  if (req.body.confirmation !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm replacing database contents.' });
  if (!req.file || !req.file.originalname.toLowerCase().endsWith('.sql')) return res.status(400).json({ error: 'Upload a .sql backup file.' });
  const executable = process.env.MYSQL_PATH || 'mysql';
  const child = spawn(executable, ['--host', process.env.DB_HOST || 'localhost', '--port', String(process.env.DB_PORT || 3306), '--user', process.env.DB_USER || 'root', process.env.DB_NAME || 'payroll_db'], { env: mysqlEnvironment(), stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', error => res.status(503).json({ error: `Could not start mysql restore client. Configure MYSQL_PATH: ${error.message}` }));
  child.on('close', code => code === 0 ? res.json({ success: true }) : res.status(400).json({ error: stderr || 'Restore failed.' }));
  child.stdin.end(req.file.buffer);
}));

module.exports = router;
