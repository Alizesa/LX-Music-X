const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { readSigningCertificate } = require('./signing.cjs')

const ROOT = path.resolve(__dirname, '..')

function getBuildToolsVersion(root = ROOT, readFile = fs.readFileSync) {
  const gradle = readFile(path.join(root, 'android/build.gradle'), 'utf8')
  const declarations = [...gradle.matchAll(/^[ \t]*buildToolsVersion[ \t]*=[ \t]*(["'])(\d+\.\d+\.\d+(?:-rc\d+)?)\1[ \t]*;?[ \t]*(?:\/\/[^\r\n]*)?\r?$/gm)]
  if (declarations.length !== 1) throw new Error('Declare one explicit Android buildToolsVersion in android/build.gradle')
  return declarations[0][2]
}

function createApkInspector({ root = ROOT, env = process.env, execute = execFileSync, exists = fs.existsSync, readFile = fs.readFileSync, platform = process.platform } = {}) {
  let version
  const tools = new Map()
  const toolPath = name => {
    if (tools.has(name)) return tools.get(name)
    version ??= getBuildToolsVersion(root, readFile)
    const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT
    if (!sdk) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is required to inspect APKs')
    const file = path.join(sdk, 'build-tools', version, name === 'apksigner' ? 'lib/apksigner.jar' : platform === 'win32' ? `${name}.exe` : name)
    if (!exists(file)) throw new Error(`Android Build Tools ${version} is missing ${name}; install build-tools;${version}`)
    tools.set(name, file)
    return file
  }
  const run = (command, args) => execute(command, args, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return (file, { signingApplicationId } = {}) => {
    let verification
    try {
      const badging = run(toolPath('aapt'), ['dump', 'badging', file])
      const match = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging)
      if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Cannot read Android package metadata')
      const metadata = { applicationId: match[1], versionCode: Number(match[2]), version: match[3] }
      // APKs from a different application cannot be installed over this fork.
      // Their signatures (including upstream rotations) are not this app's pin.
      if (signingApplicationId && metadata.applicationId !== signingApplicationId) return metadata
      const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', platform === 'win32' ? 'java.exe' : 'java') : 'java'
      verification = run(java, ['-jar', toolPath('apksigner'), 'verify', '--print-certs', file])
      return { ...metadata, certificateSha256: readSigningCertificate(verification) }
    } catch (error) {
      const output = [verification, error.stdout?.toString(), error.stderr?.toString()].filter(Boolean).join('\n')
      const details = output.split(/\r?\n/).filter(line => /certificate SHA-256|Number of signers|DOES NOT VERIFY|ERROR:|Exception|Error:/.test(line)).slice(0, 12).join('\n').slice(0, 2400)
      throw new Error(`Cannot inspect ${path.basename(file)} with Android Build Tools ${version ?? 'unresolved'}: ${String(error.message).slice(0, 1200)}${details ? `\n${details}` : ''}`, { cause: error })
    }
  }
}

if (require.main === module) {
  const version = getBuildToolsVersion()
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  console.log(`Using Android Build Tools ${version} declared by android/build.gradle`)
}

module.exports = { getBuildToolsVersion, createApkInspector }
