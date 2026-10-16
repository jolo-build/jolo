import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { openChatFile, resolveChatFile } from './chat-files.js';

const execute = promisify(execFile);
// Fixed program; file paths are argv, never interpolated into executable code.
const APPLICATIONS_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var defaultPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var location = ObjC.unwrap(urls.objectAtIndex(i).path);
    var png = null;
    try {
      var image = workspace.iconForFile(location);
      image.size = $.NSMakeSize(32, 32);
      image.lockFocus;
      var bitmap = $.NSBitmapImageRep.alloc.initWithFocusedViewRect($.NSMakeRect(0, 0, 32, 32));
      image.unlockFocus;
      png = 'data:image/png;base64,' + ObjC.unwrap(bitmap.representationUsingTypeProperties($.NSPNGFileType, $({})).base64EncodedStringWithOptions(0));
    } catch (error) {}
    apps.push({ icon: png, bundleId: ObjC.unwrap($.NSBundle.bundleWithURL(urls.objectAtIndex(i)).bundleIdentifier), path: location, name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(location)), preferred: location === defaultPath });
  }
  return JSON.stringify(apps);
}`;

export async function applicationsForFile(target) {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', APPLICATIONS_SCRIPT, '--', target], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
  const apps = JSON.parse(stdout);
  const seen = new Set();
  return apps.filter(app => typeof app.name === 'string' && typeof app.path === 'string' && path.isAbsolute(app.path) && app.path.endsWith('.app'))
    .filter(app => app.preferred || !app.path.includes('.app/') && !/\/(?:Caches|\.cache)\//.test(app.path))
    .sort((a, b) => Number(b.preferred) - Number(a.preferred))
    .filter(app => { const key = app.bundleId || app.path; if (seen.has(key)) return false; seen.add(key); return true; });
}

export async function launchFileApplication(target, application) {
  if (!path.isAbsolute(application) || !application.endsWith('.app') || !(await stat(application)).isDirectory() || !(await stat(path.join(application, 'Contents/Info.plist'))).isFile()) throw new Error('Choose a macOS application.');
  await execute('/usr/bin/open', ['-a', application, '--', target], { timeout: 10000, maxBuffer: 64 * 1024 });
}

/** Resolve only tracked files to an immutable GitHub revision. Never send a local path as a URL. */
export async function githubFileUrl(target) {
  const git = async args => (await execute('git', ['-C', path.dirname(target), ...args], { timeout: 3000, maxBuffer: 64 * 1024 })).stdout.trim();
  try {
    const root = await git(['rev-parse', '--show-toplevel']);
    const relative = path.relative(root, await realpath(target));
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
    await execute('git', ['--literal-pathspecs', '-C', root, 'ls-files', '--error-unmatch', '--', relative], { timeout: 3000, maxBuffer: 64 * 1024 });
    const remote = await git(['remote', 'get-url', 'origin']);
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
    const revision = await git(['rev-parse', 'HEAD']);
    if (!match || !/^[a-f0-9]{40,64}$/.test(revision)) return null;
    await execute('git', ['-C', root, 'cat-file', '-e', `${revision}:${relative.split(path.sep).join('/')}`], { timeout: 3000, maxBuffer: 64 * 1024 });
    return `https://github.com/${match[1]}/${match[2]}/blob/${revision}/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
  } catch { return null; }
}

export async function fileApplicationChoices(call, { app, platform = process.platform, list = applicationsForFile, github = githubFileUrl }, params) {
  const { target } = await resolveChatFile(call, params);
  let applications = [], error = null;
  if (platform === 'darwin') {
    try { applications = await list(target); } catch { error = 'Could not load installed apps.'; }
  }
  const apps = await Promise.all(applications.map(async application => {
    let icon = application.icon || null;
    try { if (!icon) icon = (await app.getFileIcon(application.path, { size: 'normal' })).resize({ width: 24, height: 24 }).toDataURL(); } catch { /* The name still identifies the application. */ }
    return { ...application, name: application.name.replace(/\.app$/, ''), icon };
  }));
  return { apps, error, canChoose: platform === 'darwin', githubUrl: await github(target) };
}

/** Renderer choices are checked against current OS associations; only the native dialog chooses other apps or save destinations. */
export async function fileApplicationAction(call, { window, dialog, shell, platform = process.platform, list = applicationsForFile, launch = launchFileApplication, github = githubFileUrl }, params) {
  const { target } = await resolveChatFile(call, params);
  if (params.action === 'reveal') { shell.showItemInFolder(target); return; }
  if (params.action === 'default') { await openChatFile(call, shell, params); return; }
  if (params.action === 'github') {
    const url = await github(target);
    if (!url) throw new Error('This file has no tracked GitHub location.');
    await shell.openExternal(url); return;
  }
  if (params.action === 'save') {
    const selection = await dialog.showSaveDialog(window, { title: 'Save file as', defaultPath: path.basename(target) });
    if (selection.canceled || !selection.filePath || path.resolve(selection.filePath) === target) return;
    await copyFile(target, selection.filePath); return;
  }
  if (platform !== 'darwin') throw new Error('Choosing an application is currently supported on macOS.');
  let application;
  if (params.action === 'choose') {
    const selection = await dialog.showOpenDialog(window, { title: 'Choose an application', buttonLabel: 'Open with', defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }] });
    if (selection.canceled || !selection.filePaths.length) return;
    application = selection.filePaths[0];
  } else if (params.action === 'application') {
    const apps = await list(target);
    application = apps.find(item => item.path === params.application)?.path;
    if (!application) throw new Error('This application is no longer available for this file. Choose another app.');
  } else throw new Error('Unknown file action.');
  await launch(target, application);
}
