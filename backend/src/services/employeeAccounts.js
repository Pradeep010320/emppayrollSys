const { randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Admin, Employee, sequelize } = require('../models');

async function createEmployeeWithLogin(values) {
  const email = String(values.email || '').trim().toLowerCase();
  const fullName = String(values.fullName || '').trim();
  if (!fullName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('Full name and a valid work email are required.');
    error.status = 400;
    throw error;
  }

  const existingEmployee = await Employee.findOne({ where: { email } });
  const existingAccount = await Admin.findOne({ where: { email } });
  if (existingEmployee || existingAccount) {
    const error = new Error('An employee or workspace account already uses this email.');
    error.status = 409;
    throw error;
  }

  const tempPassword = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const employeeId = values.employeeId || `EMP-${Date.now().toString(36).toUpperCase()}-${randomBytes(5).toString('hex').toUpperCase()}`;
  const employeeValues = {
    fullName,
    email,
    employeeId,
    phone: values.phone || null,
    gender: values.gender || null,
    dateOfBirth: values.dateOfBirth || null,
    departmentId: values.departmentId || null,
    designation: values.designation || null,
    joiningDate: values.joiningDate || null,
    employmentStatus: values.employmentStatus || 'Active',
    address: values.address || null,
    bankAccountNumber: values.bankAccountNumber || null,
    ifscCode: values.ifscCode || null,
    panNumber: values.panNumber || null
  };

  try {
    const employee = await sequelize.transaction(async transaction => {
      const created = await Employee.create(employeeValues, { transaction });
      await Admin.create({
        fullName,
        email,
        passwordHash,
        role: 'employee',
        employeeId: created.id,
        mustChangePassword: true
      }, { transaction });
      return created;
    });

    return {
      employee,
      credentials: { employeeId, loginId: email, temporaryPassword: tempPassword }
    };
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      error.status = 409;
      error.message = 'An employee or workspace account already uses this email.';
    }
    throw error;
  }
}

module.exports = { createEmployeeWithLogin };
