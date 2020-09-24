import * as OSS from "ali-oss";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as md5 from "md5";
import * as path from "path";
import * as vscode from "vscode";
import { LegalImageExt } from "../const/ENUM";
import { ZhihuOSSAgent } from "../const/HTTP";
import { ShellScriptPath } from "../const/PATH";
import { ImageHostAPI, ImageUpload } from "../const/URL";
import { getExtensionPath } from "../global/globa-var";
import { Output } from "../global/logger";
import { IImageUploadToken } from "../model/publish/image.model";
import { sendRequest } from "./http.service";
import { getCache, setCache } from "../global/cache";

/**
 * Paste Service for image upload
 */
export class PasteService {
    
    public constructor(
    ) {
    }
    /**
	 * ## @zhihu.uploadImageFromClipboard
	 * @param imagePath path to be pasted. use default if not set.
	 * @return object_name generated by OSS
	 */
    public uploadImageFromClipboard() {
        const imagePath = path.join(getExtensionPath(), `${Date.now()}.png`);
        this.saveClipboardImageToFileAndGetPath(imagePath, async () => {
            await this.uploadImageFromLink(imagePath, true);
            fs.unlinkSync(imagePath);
        });
    }

    public async uploadImageFromExplorer(uri?: vscode.Uri) {
        const imageUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                Images: ["png", "jpg", "gif"],
            },
            openLabel: "选择要上传的图片：",
        }).then(uris => {
            return uris ? uris[0] : undefined
                ;
        });
        this.uploadImageFromLink(imageUri.fsPath, true);
    }

    /**
	 * Upload image from other domains or relative link specified by `link`, and return the resolved zhihu link
	 * @param link the outer link
	 */
    public async uploadImageFromLink(link: string, insert?: boolean): Promise<string> {
        if (getCache(link)) {
            if (insert) {
                this.insertImageLink(getCache(link), true);
            }
            return Promise.resolve(getCache(link));
        }
        const zhihu_agent = ZhihuOSSAgent;
        const outerPic = /^https:\/\/.*/g;
        let buffer;
        if (outerPic.test(link)) {
            buffer = await sendRequest({
                uri: link,
                gzip: false,
                encoding: null,
                enableCache: true
            });
        } else {
            if(!path.isAbsolute(link)) {
                let _dir = path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
                link = path.join(_dir, link);    
            }
            try {
                buffer = fs.readFileSync(link);                
            } catch (error) {
                Output('图片获取失败！', 'warn')
                buffer = undefined
            }
        }
        if (!buffer) {
            Output(`${link} 图片获取异常，请调整链接再试！`, 'warn')
            throw new Error(`${link} 图片获取异常，请调整链接再试！`);
        }
        const hash = md5(buffer);

        const options = {
            method: "POST",
            uri: ImageUpload,
            body: {
                image_hash: hash,
                source: "answer",
            },
            headers: {},
            json: true,
            resolveWithFullResponse: true,
            simple: false,
        };

        const prefetchResp = await sendRequest(options);
        if (prefetchResp.statusCode == 401) {
            vscode.window.showWarningMessage("登录之后才可上传图片！");

            return;
        }
        const prefetchBody: IImageUploadToken = prefetchResp.body;
        const upload_file = prefetchBody.upload_file;
        if (prefetchBody.upload_token) {
            zhihu_agent.options.accessKeyId = prefetchBody.upload_token.access_id;
            zhihu_agent.options.accessKeySecret = prefetchBody.upload_token.access_key;
            zhihu_agent.options.stsToken = prefetchBody.upload_token.access_token;
            const client = new OSS(zhihu_agent.options);
            console.log(prefetchBody);
            // Object表示上传到OSS的Object名称，localfile表示本地文件或者文件路径
            const putResp = client.put(upload_file.object_key, buffer);
            console.log(putResp);
            putResp.then(r => {
                if (insert) {
                    this.insertImageLink(`${prefetchBody.upload_file.object_key}${path.extname(link)}`);
                }
            }).catch(e => {
                Output(`上传图片${link}失败！`, 'warn')
            })
        } else {
            if (insert) {
                this.insertImageLink(`v2-${hash}${path.extname(link)}`);
            }
        }
        setCache(link, `${ImageHostAPI}/v2-${hash}${path.extname(link)}`);
        return Promise.resolve(`${ImageHostAPI}/v2-${hash}${path.extname(link)}`);
    }
    /**
	 * ### @zhihu.uploadImageFromPath
	 *
	 */
    public async uploadImageFromPath(uri?: vscode.Uri) {
        let _path: string;
        if (uri) {
            _path = uri.fsPath;
        } else {
            _path = await vscode.env.clipboard.readText();
        }
        if (LegalImageExt.includes(path.extname(_path))) {
            if (path.isAbsolute(_path)) {
                this.uploadImageFromLink(_path, true);
            } else {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    this.uploadImageFromLink(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, _path), true);
                } else {
                    vscode.window.showWarningMessage("上传图片前请先打开一个文件夹！");
                }
            }
        } else {
            vscode.window.showWarningMessage(`不支持的文件类型！${path.extname(_path)}\n\
			仅支持上传 ${LegalImageExt.toString()}`);
        }
    }

    /**
	 * Insert Markdown inline image in terms of filename
	 * @param filename
	 */
    private insertImageLink(filename: string, absolute?: boolean) {
        const editor = vscode.window.activeTextEditor;
        const uri = editor.document.uri;
        if (uri.scheme === "untitled") {
            vscode.window.showWarningMessage("请先保存当前编辑文件！");
            return;
        }
        editor.edit(e => {
            const current = editor.selection;
            if (absolute) {
                e.insert(current.start, `![Image](${filename})`)
            } else {
                e.insert(current.start, `![Image](${ImageHostAPI}/${filename})`);
            }
        });

    }

    private saveClipboardImageToFileAndGetPath(imagePath: string, cb: () => void) {
        if (!imagePath) {
            return;
        }

        const platform = process.platform;
        if (platform === "win32") {
            // Windows
            const scriptPath = path.join(getExtensionPath(), ShellScriptPath, "pc.ps1");

            let command = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
            const powershellExisted = fs.existsSync(command);
            if (!powershellExisted) {
                command = "powershell";
            }

            const powershell = childProcess.spawn(command, [
                "-noprofile",
                "-noninteractive",
                "-nologo",
                "-sta",
                "-executionpolicy", "unrestricted",
                "-windowstyle", "hidden",
                "-file", scriptPath,
                imagePath,
            ]);
            powershell.on("error", function (e: Error) {
                vscode.window.showErrorMessage(e.message);
            });
            powershell.on("exit", function (code, signal) {
                // Console.log('exit', code, signal);
            });
            powershell.stdout.on("data", function (data: Buffer) {
                cb();
            });
        } else if (platform === "darwin") {
            // Mac
            const scriptPath = path.join(__dirname, ShellScriptPath, "mac.applescript");

            const ascript = childProcess.spawn("osascript", [scriptPath, imagePath]);
            ascript.on("error", function (e) {
                vscode.window.showErrorMessage(e.message);
            });
            ascript.on("exit", function (code, signal) {
                // Console.log('exit',code,signal);
            });
            ascript.stdout.on("data", function (data: Buffer) {
                cb();
            });
        } else {
            // Linux

            const scriptPath = path.join(__dirname, ShellScriptPath, "linux.sh");

            const ascript = childProcess.spawn("sh", [scriptPath, imagePath]);
            ascript.on("error", function (e) {
                vscode.window.showErrorMessage(e.message);
            });
            ascript.on("exit", function (code, signal) {
                // Console.log('exit',code,signal);
            });
            ascript.stdout.on("data", function (data: Buffer) {
                const result = data.toString().trim();
                if (result == "no xclip") {
                    vscode.window.showInformationMessage("You need to install xclip command first.");

                    return;
                }
                cb();
            });
        }
    }

}