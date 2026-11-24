require('dotenv').config();
const { sequelize, Department, Employee, Salary, Payroll, Payslip } = require('./models');

(async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync();
    const departmentRows = [
      ['DEP-001','Engineering','Product engineering and platform','Olivia Martin'],
      ['DEP-002','People','People operations','Daniel Kim'],
      ['DEP-003','Finance','Finance and accounting','Amara Okafor'],
      ['DEP-004','Design','Product design','Lucas Chen']
    ];
    const departments = {};
    for (const [departmentId,departmentName,description,managerName] of departmentRows) {
      const [department] = await Department.findOrCreate({ where: { departmentName }, defaults: { departmentId,description,managerName } });
      departments[departmentName] = department.id;
    }
    const people = [
      ['EMP-1001','Ava Patel','ava.patel@example.com','Senior Engineer','Engineering',7200,1200,400,300,45,500,80,720],
      ['EMP-1002','Noah Williams','noah.williams@example.com','People Partner','People',5900,1000,350,200,35,420,80,510],
      ['EMP-1003','Mia Chen','mia.chen@example.com','Financial Analyst','Finance',6400,1100,300,250,40,450,80,580],
      ['EMP-1004','Ethan Brooks','ethan.brooks@example.com','Product Manager','Engineering',8100,1400,500,400,50,600,80,900],
      ['EMP-1005','Isabella Garcia','isabella.garcia@example.com','UX Designer','Design',6200,1050,350,250,38,440,80,540]
    ];
    for (const [employeeId,fullName,email,designation,department,basicSalary,hra,allowances,bonus,overtimeRate,providentFund,professionalTax,incomeTax] of people) {
      const [employee] = await Employee.findOrCreate({ where: { email }, defaults: { employeeId,fullName,email,designation,departmentId:departments[department],joiningDate:'2023-01-09',employmentStatus:'Active' } });
      await Salary.findOrCreate({ where: { employeeId: employee.id }, defaults: { basicSalary,hra,allowances,bonus,overtimeRate,providentFund,professionalTax,incomeTax,otherDeductions:0 } });
    }
    console.log('Demo departments, employees, and salary structures are ready.');
  } catch (error) { console.error('Seed failed:', error.message); process.exitCode = 1; }
  finally { await sequelize.close(); }
})();
