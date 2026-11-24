const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const model = (name, fields, options = {}) => sequelize.define(name, fields, options);

const Admin = model('Admin', {
  fullName: { type: DataTypes.STRING(120), allowNull: false },
  email: { type: DataTypes.STRING(190), allowNull: false, unique: true, validate: { isEmail: true } },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false },
  role: { type: DataTypes.STRING(40), defaultValue: 'admin', allowNull: false },
  employeeId: { type: DataTypes.INTEGER, allowNull: true, unique: true },
  mustChangePassword: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  twoFactorSecret: { type: DataTypes.STRING(128), allowNull: true },
  twoFactorEnabled: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false }
}, { tableName: 'admins' });
const Department = model('Department', {
  departmentId: { type: DataTypes.STRING(24), unique: true, allowNull: false },
  departmentName: { type: DataTypes.STRING(100), unique: true, allowNull: false },
  description: DataTypes.TEXT, managerName: DataTypes.STRING(120)
}, { tableName: 'departments' });
const Employee = model('Employee', {
  employeeId: { type: DataTypes.STRING(24), unique: true, allowNull: false },
  fullName: { type: DataTypes.STRING(140), allowNull: false },
  email: { type: DataTypes.STRING(190), allowNull: false, unique: true, validate: { isEmail: true } },
  phone: DataTypes.STRING(30), gender: DataTypes.STRING(30), dateOfBirth: DataTypes.DATEONLY,
  designation: DataTypes.STRING(100), joiningDate: DataTypes.DATEONLY, address: DataTypes.TEXT,
  bankAccountNumber: DataTypes.STRING(64), ifscCode: DataTypes.STRING(24), panNumber: DataTypes.STRING(24),
  employmentStatus: { type: DataTypes.ENUM('Active', 'On Leave', 'Inactive'), defaultValue: 'Active' }
}, { tableName: 'employees', indexes: [{ fields: ['full_name'] }] });
const Attendance = model('Attendance', {
  attendanceDate: { type: DataTypes.DATEONLY, allowNull: false },
  status: { type: DataTypes.ENUM('Present', 'Absent', 'Paid Leave', 'Unpaid Leave'), allowNull: false },
  overtimeHours: { type: DataTypes.DECIMAL(7, 2), defaultValue: 0 }, notes: DataTypes.STRING(255)
}, { tableName: 'attendance', indexes: [{ unique: true, fields: ['employee_id', 'attendance_date'] }] });
const Salary = model('SalaryStructure', {
  basicSalary: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 }, hra: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  allowances: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 }, bonus: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  overtimeRate: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 }, providentFund: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  professionalTax: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 }, incomeTax: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  otherDeductions: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 }
}, { tableName: 'salary_structures' });
const Payroll = model('Payroll', {
  month: { type: DataTypes.TINYINT, allowNull: false, validate: { min: 1, max: 12 } },
  year: { type: DataTypes.SMALLINT, allowNull: false }, presentDays: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
  unpaidLeaveDays: { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 }, overtimeHours: { type: DataTypes.DECIMAL(7, 2), defaultValue: 0 },
  grossSalary: { type: DataTypes.DECIMAL(12, 2), allowNull: false }, totalDeductions: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  netSalary: { type: DataTypes.DECIMAL(12, 2), allowNull: false }, earnings: DataTypes.JSON, deductions: DataTypes.JSON,
  status: { type: DataTypes.ENUM('Pending', 'Paid', 'Cancelled'), defaultValue: 'Pending' },
  approvalStatus: { type: DataTypes.STRING(20), defaultValue: 'Pending', allowNull: false },
  approvedBy: DataTypes.INTEGER, approvedAt: DataTypes.DATE, approvalNote: DataTypes.STRING(500), paymentDate: DataTypes.DATEONLY
}, { tableName: 'payrolls', indexes: [{ unique: true, fields: ['employee_id', 'month', 'year'] }, { fields: ['status', 'year', 'month'] }] });
const Payslip = model('Payslip', { pdfPath: DataTypes.STRING(500) }, { tableName: 'payslips' });
const ActivityLog = model('ActivityLog', { action: { type: DataTypes.STRING(80), allowNull: false }, entityType: DataTypes.STRING(80), entityId: DataTypes.INTEGER, details: DataTypes.JSON }, { tableName: 'activity_logs' });
const LeaveRequest = model('LeaveRequest', {
  startDate: { type: DataTypes.DATEONLY, allowNull: false }, endDate: { type: DataTypes.DATEONLY, allowNull: false },
  leaveType: { type: DataTypes.ENUM('Paid', 'Unpaid', 'Sick', 'Personal'), allowNull: false },
  reason: DataTypes.STRING(1000), status: { type: DataTypes.STRING(20), defaultValue: 'Pending', allowNull: false },
  reviewedBy: DataTypes.INTEGER, reviewedAt: DataTypes.DATE, reviewerNote: DataTypes.STRING(500)
}, { tableName: 'leave_requests', indexes: [{ fields: ['employee_id', 'status'] }] });
const SalaryRevision = model('SalaryRevision', {
  effectiveDate: { type: DataTypes.DATEONLY, allowNull: false }, reason: DataTypes.STRING(500),
  snapshot: { type: DataTypes.JSON, allowNull: false }
}, { tableName: 'salary_revisions', indexes: [{ fields: ['employee_id', 'effective_date'] }] });
const Notification = model('Notification', {
  title: { type: DataTypes.STRING(160), allowNull: false }, message: { type: DataTypes.STRING(1000), allowNull: false },
  category: { type: DataTypes.STRING(40), defaultValue: 'general' }, readAt: DataTypes.DATE, link: DataTypes.STRING(255)
}, { tableName: 'notifications' });
const CompanySetting = model('CompanySetting', {
  key: { type: DataTypes.STRING(80), unique: true, allowNull: false }, value: { type: DataTypes.JSON, allowNull: false }
}, { tableName: 'company_settings' });

Employee.belongsTo(Department, { foreignKey: { name: 'departmentId', allowNull: true }, onDelete: 'SET NULL' });
Department.hasMany(Employee, { foreignKey: 'departmentId' });
Attendance.belongsTo(Employee, { foreignKey: { name: 'employeeId', allowNull: false }, onDelete: 'CASCADE' });
Employee.hasMany(Attendance, { foreignKey: 'employeeId' });
Salary.belongsTo(Employee, { foreignKey: { name: 'employeeId', allowNull: false }, onDelete: 'CASCADE' });
Employee.hasOne(Salary, { foreignKey: 'employeeId' });
Payroll.belongsTo(Employee, { foreignKey: { name: 'employeeId', allowNull: false }, onDelete: 'RESTRICT' });
Employee.hasMany(Payroll, { foreignKey: 'employeeId' });
Payslip.belongsTo(Payroll, { foreignKey: { name: 'payrollId', allowNull: false }, onDelete: 'CASCADE' });
Payroll.hasOne(Payslip, { foreignKey: 'payrollId' });
ActivityLog.belongsTo(Admin, { foreignKey: { name: 'adminId', allowNull: true }, onDelete: 'SET NULL' });
Admin.belongsTo(Employee, { foreignKey: { name: 'employeeId', allowNull: true }, onDelete: 'SET NULL' });
Employee.hasOne(Admin, { foreignKey: 'employeeId' });
LeaveRequest.belongsTo(Employee, { foreignKey: { name: 'employeeId', allowNull: false }, onDelete: 'CASCADE' });
Employee.hasMany(LeaveRequest, { foreignKey: 'employeeId' });
SalaryRevision.belongsTo(Employee, { foreignKey: { name: 'employeeId', allowNull: false }, onDelete: 'CASCADE' });
Employee.hasMany(SalaryRevision, { foreignKey: 'employeeId' });
Notification.belongsTo(Admin, { foreignKey: { name: 'adminId', allowNull: false }, onDelete: 'CASCADE' });
Admin.hasMany(Notification, { foreignKey: 'adminId' });
Payroll.belongsTo(Admin, { as: 'Approver', foreignKey: { name: 'approvedBy', allowNull: true }, onDelete: 'SET NULL' });

module.exports = { sequelize, Admin, Department, Employee, Attendance, Salary, Payroll, Payslip, ActivityLog, LeaveRequest, SalaryRevision, Notification, CompanySetting };
