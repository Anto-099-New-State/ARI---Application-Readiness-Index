const { exec } = require("child_process");
const fs = require("fs/promises");
const fs_sync = require("fs"); // For reliable callback-style cleanup
const path = require("path");

const SHALLOW_DEPTH = 1;

const MAX_CLONE_SIZE_BYTES = 50 * 1024 * 1024;

function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
      // If there's an actual execution error (e.g., command not found), reject.
      if (error && error.code !== 1) {
        reject(
          new Error(`Command failed: ${error.message}\nStderr: ${stderr}`)
        );
        return;
      }
      resolve(stdout.trim() + (stderr ? "\n" + stderr.trim() : ""));
    });
  });
}

async function runESLintAnalysis(repoDir) {
  try {
    const { ESLint } = require("eslint");

    const eslint = new ESLint({
      cwd: repoDir,
      overrideConfigFile: null, // allow repo config if present
    });

    const results = await eslint.lintFiles(["**/*.js"]);

    let errors = 0;
    let warnings = 0;

    for (const result of results) {
      errors += result.errorCount;
      warnings += result.warningCount;
    }

    return { errors, warnings };
  } catch (err) {
    console.warn("ESLint failed — applying conservative penalty");
    return {
      errors: 20,
      warnings: 50,
      failed: true,
    };
  }
}

async function runNpmAudit(repoDir) {
  // Navigate to the directory, then run audit --json
  const auditCommand = `cd ${repoDir} && npm audit --json`;
  let critical = 0;
  let high = 0;

  try {
    const output = await execCommand(auditCommand);
    const jsonOutput = JSON.parse(output);

    // npm audit structure: summary -> severities
    const summary = jsonOutput.metadata?.vulnerabilities;

    if (summary) {
      critical = summary.critical || 0;
      high = summary.high || 0;
    }
  } catch (e) {
    console.error("npm audit analysis failed to parse output:", e.message);
    // This often happens if the project has no package-lock.json or dependencies.
  }

  return { critical, high };
}

async function validateRepoByCloning(owner, repo) {
  const tempDir = path.join(
    __dirname,
    "temp_repos",
    `${owner}_${repo}_${Date.now()}`
  );
  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  let packageJsonValidationResult = {};
  let staticAnalysisResults = {};

  try {
    console.log(`Clonning ${repoUrl} to ${tempDir}... `);

    const cloneCommand = `git clone --depth ${SHALLOW_DEPTH} ${repoUrl} ${tempDir}`;
    await execCommand(cloneCommand);
    const sizeCommand =
      process.platform === "win32"
        ? `powershell -Command "(Get-ChildItem -Recurse ${tempDir} | Measure-Object -Property Length -Sum).Sum"`
        : `du -sb ${tempDir} | awk '{print $1}'`;

    const rawSizeBytes = await execCommand(sizeCommand);
    const actualSizeBytes = parseInt(rawSizeBytes);

    if (actualSizeBytes > MAX_CLONE_SIZE_BYTES) {
      return {
        isValid: false,
        message: `Clone Failed: Repository size (${(
          actualSizeBytes /
          (1024 * 1024)
        ).toFixed(2)} MB) exceeds the ${
          MAX_CLONE_SIZE_BYTES / (1024 * 1024)
        } MB limit.`,
      };
    }

    const packageJsonPath = path.join(tempDir, "package.json");
    try {
      const fileContent = await fs.readFile(packageJsonPath, "utf8");

      const fileString = String(fileContent).trim();
      const packageJson = JSON.parse(fileString);

      packageJsonValidationResult = {
        isValid: true,
        message: `'package.json' found and is valid JSON. Clone size: ${Math.round(
          actualSizeBytes / 1024
        )} KB.`,
        data: packageJson,
      };

      console.log(`Starting static analysis on ${owner}/${repo}...`);

      if (packageJsonValidationResult.isValid) {
        console.log(`Installing dependencies in ${tempDir}...`);
        try {
          await execCommand(`cd "${tempDir}" && npm install --ignore-scripts`);
          console.log(`Dependencies installed.`);
        } catch (installError) {
          console.warn(
            `Dependency installation failed: ${installError.message}`
          );
        }

        const [eslintResult, auditResult] = await Promise.all([
          runESLintAnalysis(tempDir),
          runNpmAudit(tempDir),
        ]);

        staticAnalysisResults = {
          eslint: {
            errorCount: eslintResult.errors,
            warningCount: eslintResult.warnings,
          },
          npmAudit: {
            criticalVulnerabilities: auditResult.critical,
            highVulnerabilities: auditResult.high,
          },
        };
      }
      const scoringResult = computeAriScore(staticAnalysisResults);

      const explanation = await generateLLMExplanation({
        ari_score: scoringResult.ari_score,
        status: scoringResult.status,
        metrics: scoringResult.metrics,
        context: {
          has_tests: false,
          eslint_failed: staticAnalysisResults.eslint.failed || false,
        },
      });

      return {
        isValid: true,
        message: `'package.json' found and is valid JSON. Clone size: ${Math.round(
          actualSizeBytes / 1024
        )} KB.`,
        data: packageJson,
        ...packageJsonValidationResult,
        analysis: staticAnalysisResults,
        ari_score: scoringResult.ari_score,
        status: scoringResult.status,
        metrics: scoringResult.metrics,
        ...existingResult,
        explanation,
      };
    } catch (readParseError) {
      if (readParseError.code === "ENOENT") {
        // File not found error
        return {
          isValid: false,
          message: `'package.json' NOT found in the repository.`,
        };
      }
      // JSON parsing error
      return {
        isValid: false,
        message: `'package.json' found but is NOT valid JSON: ${readParseError.message}`,
      };
    }
  } catch (gitError) {
    // 4. Handle Clone Failure (Repo not found, network issues, etc.)
    return {
      isValid: false,
      message: `Clone Failed: ${gitError.message.substring(0, 200)}...`, // Truncate error for clean output
    };
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`Cleaned up temp directory: ${tempDir}`);
    } catch (cleanupError) {
      console.error(
        `Warning: Failed to clean up temp directory ${tempDir}:`,
        cleanupError.message
      );
    }
  }
}

function computeAriScore(analysis) {
  const { eslint, npmAudit } = analysis;

  // scoring weights
  const WEIGHT_ESLINT_ERROR = 1;
  const WEIGHT_ESLINT_WARNING = 0.25;
  const WEIGHT_CRITICAL_VULN = 15;
  const WEIGHT_HIGH_VULN = 5;
  const STARTING_SCORE = 100;

  // metric values
  const errors = eslint.errorCount;
  const warnings = eslint.warningCount;
  const critical = npmAudit.criticalVulnerabilities;
  const high = npmAudit.highVulnerabilities;

  //calculation
  const deduction =
    errors * WEIGHT_ESLINT_ERROR +
    warnings * WEIGHT_ESLINT_WARNING +
    critical * WEIGHT_CRITICAL_VULN +
    high * WEIGHT_HIGH_VULN;

  let rawScore = STARTING_SCORE - deduction;

  const finalScore = Math.max(0, Math.min(100, rawScore));
  const roundedScore = Math.round(finalScore);

  let status = "High Risk";
  if (roundedScore >= 80) {
    status = "Low Risk";
  } else if (roundedScore >= 60) {
    status = "Moderate Risk";
  }

  return {
    ari_score: roundedScore,
    status: status,
    metrics: {
      eslint_errors: errors,
      eslint_warnnings: warnings,
      critical_vulns: critical,
      high_vulns: high,
    },
  };
}

async function runExample() {
  console.log(
    "--- Checking Valid Repo (Anto-099-New-State/ARI---Application-Readiness-Index) ---"
  );
  let result = await validateRepoByCloning(
    "Anto-099-New-State",
    "ARI---Application-Readiness-Index"
  );
  console.log(result);
}

runExample();
