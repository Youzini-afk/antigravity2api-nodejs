import esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const bundleDir = path.join(distDir, 'bundle');

// 转换为正斜杠路径（跨平台兼容）
const toSlash = (p) => p.replace(/\\/g, '/');

// 确保目录存在
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(bundleDir)) {
  fs.mkdirSync(bundleDir, { recursive: true });
}

// 获取命令行参数
const args = process.argv.slice(2);
const targetArg = args.find(arg => arg.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : 'node18-win-x64';

// 解析目标平台
const targetMap = {
  'win': 'node18-win-x64',
  'win-x64': 'node18-win-x64',
  'linux': 'node18-linux-x64',
  'linux-x64': 'node18-linux-x64',
  'linux-arm64': 'node18-linux-arm64',
  'macos': 'node18-macos-x64',
  'macos-x64': 'node18-macos-x64',
  'macos-arm64': 'node18-macos-arm64',
  'all': 'node18-win-x64,node18-linux-x64,node18-linux-arm64,node18-macos-x64,node18-macos-arm64'
};

const resolvedTarget = targetMap[target] || target;

// 输出文件名映射
const outputNameMap = {
  'node18-win-x64': 'antigravity-win-x64.exe',
  'node18-linux-x64': 'antigravity-linux-x64',
  'node18-linux-arm64': 'antigravity-linux-arm64',
  'node18-macos-x64': 'antigravity-macos-x64',
  'node18-macos-arm64': 'antigravity-macos-arm64'
};

// 平台对应的 bin 文件映射
const binFileMap = {
  'node18-win-x64': 'fingerprint_windows_amd64.exe',
  'node18-linux-x64': 'fingerprint_linux_amd64',
  'node18-linux-arm64': 'fingerprint_android_arm64',
  'node18-macos-x64': 'fingerprint_linux_amd64',
  'node18-macos-arm64': 'fingerprint_android_arm64'
};

console.log('📦 Step 1: Bundling with esbuild...');

// 使用 esbuild 打包成 CommonJS
await esbuild.build({
  entryPoints: ['src/server/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(bundleDir, 'server.cjs'),
  external: [],
  minify: false,
  sourcemap: false,
  // 处理 __dirname 和 __filename
  define: {
    'import.meta.url': 'importMetaUrl'
  },
  banner: {
    js: `
const importMetaUrl = require('url').pathToFileURL(__filename).href;
const __importMetaDirname = __dirname;
`
  },
  // 复制静态资源
  loader: {
    '.node': 'copy'
  }
});

console.log('✅ Bundle created: dist/bundle/server.cjs');

// 创建临时 package.json 用于 pkg
// 使用绝对路径引用资源文件
  const pkgJson = {
  name: 'antigravity-to-openai',
  version: '1.0.0',
  bin: 'server.cjs',
  pkg: {
    assets: [
      toSlash(path.join(rootDir, 'public', '**/*')),
      toSlash(path.join(rootDir, 'public', '*.html')),
      toSlash(path.join(rootDir, 'public', '*.css')),
      toSlash(path.join(rootDir, 'public', 'js', '*.js')),
      toSlash(path.join(rootDir, 'public', 'assets', '*')),
      toSlash(path.join(rootDir, 'src', 'bin', '*')),
      toSlash(path.join(rootDir, 'src', 'utils', 'proto', '*.proto'))
    ]
  }
};

fs.writeFileSync(
  path.join(bundleDir, 'package.json'),
  JSON.stringify(pkgJson, null, 2)
);

console.log('📦 Step 2: Building executable with pkg...');

// 执行 pkg 命令的辅助函数
function runPkg(args) {
  // 将参数中的路径转换为正斜杠格式
  const quotedArgs = args.map(arg => {
    if (arg.includes(' ') || arg.includes('\\')) {
      return `"${arg.replace(/\\/g, '/')}"`;
    }
    return arg;
  });
  
  const cmd = `npx pkg ${quotedArgs.join(' ')}`;
  console.log(`Running: ${cmd}`);
  
  try {
    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    });
  } catch (error) {
    throw new Error(`pkg failed: ${error.message}`);
  }
}

// 构建 pkg 命令
const targets = resolvedTarget.split(',');
const isMultiTarget = targets.length > 1;

try {
  const pkgJsonPath = path.join(bundleDir, 'package.json');
  
  // 删除旧的可执行文件（避免 EPERM 错误）
  if (isMultiTarget) {
    for (const t of targets) {
      const oldFile = path.join(distDir, outputNameMap[t] || 'antigravity');
      if (fs.existsSync(oldFile)) {
        console.log(`🗑️ Removing old file: ${oldFile}`);
        fs.unlinkSync(oldFile);
      }
    }
  } else {
    const outputName = outputNameMap[resolvedTarget] || 'antigravity';
    const oldFile = path.join(distDir, outputName);
    if (fs.existsSync(oldFile)) {
      console.log(`🗑️ Removing old file: ${oldFile}`);
      fs.unlinkSync(oldFile);
    }
  }
  
  if (isMultiTarget) {
    // 多目标构建
    runPkg([pkgJsonPath, '--target', resolvedTarget, '--compress', 'GZip', '--out-path', distDir]);
  } else {
    // 单目标构建
    const outputName = outputNameMap[resolvedTarget] || 'antigravity';
    const outputPath = path.join(distDir, outputName);
    
    // ARM64 在 Windows 上交叉编译时禁用压缩（避免 spawn UNKNOWN 错误）
    const isArm64 = resolvedTarget.includes('arm64');
    const isWindows = process.platform === 'win32';
    const compressArgs = (isArm64 && isWindows) ? [] : ['--compress', 'GZip'];
    
    runPkg([pkgJsonPath, '--target', resolvedTarget, ...compressArgs, '--output', outputPath]);
  }

  console.log('✅ Build complete!');
  
  // 复制运行时需要的文件到 dist 目录
  console.log('📁 Copying runtime files...');
  
  // 复制 public 目录（排除 images）
  const publicSrcDir = path.join(rootDir, 'public');
  const publicDestDir = path.join(distDir, 'public');
  console.log(`  Source: ${publicSrcDir}`);
  console.log(`  Dest: ${publicDestDir}`);
  console.log(`  Source exists: ${fs.existsSync(publicSrcDir)}`);
  
  if (fs.existsSync(publicSrcDir)) {
    try {
      if (fs.existsSync(publicDestDir)) {
        console.log('  Removing existing public directory...');
        fs.rmSync(publicDestDir, { recursive: true, force: true });
      }
      // 使用系统命令复制目录（更可靠）
      console.log('  Copying public directory...');
      if (process.platform === 'win32') {
        execSync(`xcopy /E /I /Y /Q "${publicSrcDir}" "${publicDestDir}"`, { stdio: 'pipe', shell: true });
      } else {
        fs.mkdirSync(publicDestDir, { recursive: true });
        execSync(`cp -r "${publicSrcDir}"/* "${publicDestDir}/"`, { stdio: 'pipe', shell: true });
      }
      // 删除 images 目录（运行时生成，不需要打包）
      const imagesDir = path.join(publicDestDir, 'images');
      if (fs.existsSync(imagesDir)) {
        fs.rmSync(imagesDir, { recursive: true, force: true });
      }
      console.log('  ✓ Copied public directory');
    } catch (err) {
      console.error('  ❌ Failed to copy public directory:', err.message);
      throw err;
    }
  } else {
    console.error('  ❌ Source public directory not found!');
  }
  
  // 复制 bin 目录（只复制对应平台的文件）
  const binSrcDir = path.join(rootDir, 'src', 'bin');
  const binDestDir = path.join(distDir, 'bin');
  if (fs.existsSync(binSrcDir)) {
    if (fs.existsSync(binDestDir)) {
      fs.rmSync(binDestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(binDestDir, { recursive: true });
    
    // 只复制对应平台的 bin 文件
    const targetBinFiles = isMultiTarget
      ? [...new Set(targets.map(t => binFileMap[t]).filter(Boolean))]  // 多目标：去重后的所有文件
      : [binFileMap[resolvedTarget]].filter(Boolean);  // 单目标：只复制一个文件
    
    if (targetBinFiles.length > 0) {
      for (const binFile of targetBinFiles) {
        const srcPath = path.join(binSrcDir, binFile);
        const destPath = path.join(binDestDir, binFile);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`  ✓ Copied bin/${binFile}`);
        } else {
          console.warn(`  ⚠ Warning: bin/${binFile} not found`);
        }
      }
    // 复制 tls_config.json
    const configFile = 'tls_config.json';
    const configSrcPath = path.join(binSrcDir, configFile);
    const configDestPath = path.join(binDestDir, configFile);
    if (fs.existsSync(configSrcPath)) {
      fs.copyFileSync(configSrcPath, configDestPath);
      console.log(`  ✓ Copied bin/${configFile}`);
} else {
  console.warn(`  ⚠ Warning: bin/${configFile} not found`);
}
    } else {
      // 如果没有映射，复制所有文件（兼容旧行为）
      try {
        if (process.platform === 'win32') {
          execSync(`xcopy /E /I /Y "${binSrcDir}" "${binDestDir}"`, { stdio: 'pipe', shell: true });
        } else {
          execSync(`cp -r "${binSrcDir}"/* "${binDestDir}/"`, { stdio: 'pipe', shell: true });
        }
        console.log('  ✓ Copied all bin files');
      } catch (err) {
        console.error('  ⚠ Warning: Failed to copy bin directory:', err.message);
      }
    }
  }
  
  // 复制配置文件模板（只复制 config.json）
  const configSrcPath = path.join(rootDir, 'config.json');
  const configDestPath = path.join(distDir, 'config.json');
  if (fs.existsSync(configSrcPath)) {
    fs.copyFileSync(configSrcPath, configDestPath);
    console.log('  ✓ Copied config.json');
  }
  
  // 复制 proto 文件
  const protoSrcDir = path.join(rootDir, 'src', 'utils', 'proto');
  const protoDestDir = path.join(distDir, 'src', 'utils', 'proto');
  if (fs.existsSync(protoSrcDir)) {
    fs.mkdirSync(protoDestDir, { recursive: true });
    const protoFiles = fs.readdirSync(protoSrcDir).filter(f => f.endsWith('.proto'));
    for (const protoFile of protoFiles) {
      fs.copyFileSync(
        path.join(protoSrcDir, protoFile),
        path.join(protoDestDir, protoFile)
      );
      console.log(`  ✓ Copied src/utils/proto/${protoFile}`);
    }
  }
  
  console.log('');
  console.log('🎉 Build successful!');
  console.log('');
  console.log('📋 Usage:');
  console.log('  1. Copy the dist folder to your target machine');
  console.log('  2. Run the executable (will auto-generate random credentials if not configured)');
  console.log('  3. Optionally create .env file to customize settings');
  console.log('');
  
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
} finally {
  // 清理临时文件
  if (fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    console.log('🧹 Cleaned up temporary files');
  }
}