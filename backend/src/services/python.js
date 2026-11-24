const { spawn } = require('node:child_process');

function runPython(payload) {
  return new Promise((resolve, reject) => {
    const executable = process.env.PYTHON_EXECUTABLE || 'python';
    const child = spawn(executable, [require('node:path').join(__dirname, '..', '..', '..', 'python_service', 'app.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(new Error(`Unable to start Python (${executable}): ${error.message}`)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Python service exited with code ${code}`));
      try {
        const result = JSON.parse(stdout);
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (error) { reject(new Error(`Invalid Python response: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
module.exports = { runPython };
