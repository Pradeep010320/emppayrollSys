const { Op } = require('sequelize');
const { Attendance, Employee, LeaveRequest, Payroll, Payslip, Salary, ActivityLog, Department } = require('../models');
const { runPython } = require('../services/python');
const { notifyRoles } = require('../services/notifications');

function httpError(status, message) { const error = new Error(message); error.status = status; return error; }

async function generatePayroll({ employeeId, month, year }, adminId) {
  employeeId = Number(employeeId); month = Number(month); year = Number(year);
  if (!employeeId || month < 1 || month > 12 || !year) throw httpError(400, 'Select an employee and valid month/year.');
  if (await Payroll.findOne({ where: { employeeId, month, year } })) throw httpError(409, 'Payroll already exists for this employee and period.');
  const employee = await Employee.findByPk(employeeId);
  const salary = await Salary.findOne({ where: { employeeId } });
  if (!employee || !salary) throw httpError(400, 'Employee and salary structure are required before payroll generation.');
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const attendanceRows = await Attendance.findAll({ where: { employeeId, attendanceDate: { [Op.gte]: start, [Op.lt]: end } } });
  const leaveRows = await LeaveRequest.findAll({ where: { employeeId, status: 'Approved', leaveType: 'Unpaid', startDate: { [Op.lt]: end }, endDate: { [Op.gte]: start } } });
  const unpaidDates = new Set(attendanceRows.filter(row => row.status === 'Unpaid Leave').map(row => row.attendanceDate));
  for (const leave of leaveRows) {
    const first = new Date(`${leave.startDate < start ? start : leave.startDate}T00:00:00Z`);
    const last = new Date(`${leave.endDate >= end ? new Date(Date.parse(end) - 86400000).toISOString().slice(0, 10) : leave.endDate}T00:00:00Z`);
    for (const day = new Date(first); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) unpaidDates.add(day.toISOString().slice(0, 10));
    }
  }
  const attendance = {
    presentDays: attendanceRows.filter(record => record.status === 'Present').length,
    unpaidLeaveDays: unpaidDates.size,
    overtimeHours: attendanceRows.reduce((sum, record) => sum + Number(record.overtimeHours || 0), 0)
  };
  const calculated = await runPython({ action: 'calculate', salary: salary.toJSON(), attendance, month, year });
  const payroll = await Payroll.create({ employeeId, month, year, ...attendance, grossSalary: calculated.gross_salary, totalDeductions: calculated.total_deductions, netSalary: calculated.net_salary, earnings: calculated.earnings, deductions: calculated.deductions });
  await Payslip.findOrCreate({ where: { payrollId: payroll.id } });
  ActivityLog.create({ adminId, action: 'generated', entityType: 'payroll', entityId: payroll.id, details: { month, year } }).catch(() => {});
  await notifyRoles(['admin', 'payroll_manager'], { title: 'Payroll ready for approval', message: `${employee.fullName}'s payroll for ${month}/${year} is ready for review.`, category: 'payroll', link: '/approvals' });
  return Payroll.findByPk(payroll.id, { include: [{ model: Employee, include: [Department] }] });
}

module.exports = { generatePayroll, httpError };
