const { DataTypes } = require('sequelize');

async function ensureColumn(sequelize, table, name, definition) {
  const columns = await sequelize.getQueryInterface().describeTable(table);
  if (!columns[name]) await sequelize.getQueryInterface().addColumn(table, name, definition);
}

async function migrate(sequelize) {
  await sequelize.query("ALTER TABLE admins MODIFY role VARCHAR(40) NOT NULL DEFAULT 'admin'");
  await ensureColumn(sequelize, 'admins', 'employee_id', { type: DataTypes.INTEGER, allowNull: true, unique: true });
  await ensureColumn(sequelize, 'admins', 'must_change_password', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await ensureColumn(sequelize, 'admins', 'two_factor_secret', { type: DataTypes.STRING(128), allowNull: true });
  await ensureColumn(sequelize, 'admins', 'two_factor_enabled', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await ensureColumn(sequelize, 'payrolls', 'approval_status', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'Pending' });
  await ensureColumn(sequelize, 'payrolls', 'approved_by', { type: DataTypes.INTEGER, allowNull: true });
  await ensureColumn(sequelize, 'payrolls', 'approved_at', { type: DataTypes.DATE, allowNull: true });
  await ensureColumn(sequelize, 'payrolls', 'approval_note', { type: DataTypes.STRING(500), allowNull: true });
  await ensureColumn(sequelize, 'activity_logs', 'updated_at', { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW });
  await sequelize.query("UPDATE payrolls SET approval_status = 'Approved' WHERE status = 'Paid'");
}

module.exports = { migrate };
