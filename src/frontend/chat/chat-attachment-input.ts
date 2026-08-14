/// <reference path="../dashboard.d.ts" />

interface ChatAttachmentInputDependencies {
  chat?: AppChat;
}

const chatAttachmentInputApp = (window as any).App;
const chatAttachmentInputDependencies: ChatAttachmentInputDependencies = {
  chat: chatAttachmentInputApp?.Chat,
};
const attachmentInputChat = chatAttachmentInputDependencies.chat;

class ChatAttachmentInputView {
  private cleanups: Array<() => void> = [];
  private bound = false;

  bind(): void {
    if (this.bound) return;
    this.bound = true;

    const fileButton = $('fi-file-btn');
    if (fileButton) {
      this.listen(fileButton, 'click', () => { void this.selectFile(); });
    }

    const inputArea = $('fi');
    if (inputArea) {
      this.listen(inputArea, 'dragover', (event) => {
        const dragEvent = event as DragEvent;
        dragEvent.preventDefault();
        if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'move';
        attachmentInputChat?.showDropZone?.(true);
      });
      this.listen(inputArea, 'dragleave', (event) => {
        const dragEvent = event as DragEvent;
        if (!inputArea.contains(dragEvent.relatedTarget as Node)) {
          attachmentInputChat?.showDropZone?.(false);
        }
      });
      this.listen(inputArea, 'drop', (event) => {
        void this.handleDrop(event as DragEvent);
      });
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.bound = false;
  }

  private async selectFile(): Promise<void> {
    try {
      const api = (window as any).electronAPI as ElectronAPI | undefined;
      if (api?.selectFile) {
        const path = await api.selectFile();
        if (path) {
          const workspace = ExplorerService.getWorkspacePath();
          const relativePath = workspace
            ? path.replace(workspace.replace(/\\/g, '/'), '').replace(/^\/+/, '')
            : path;
          const name = path.split(/[/\\]/).pop() || path;
          attachmentInputChat?.addAttachment?.({ kind: 'file', path: relativePath, name });
        }
      } else {
        toast('请使用 Electron 桌面版', 'info');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toast(`选择文件失败: ${detail}`, 'error');
    }
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    attachmentInputChat?.showDropZone?.(false);
    let treeNodeId = event.dataTransfer?.getData('text/tree-node');
    if (!treeNodeId) {
      const plain = event.dataTransfer?.getData('text/plain') || '';
      if (plain.startsWith('tree-node:')) treeNodeId = plain.slice(10);
    }
    if (treeNodeId) {
      const workspace = ExplorerService.getWorkspacePath();
      if (!workspace) {
        toast('请先选择工作区', 'error');
        return;
      }
      const name = treeNodeId.split('/').pop() || treeNodeId;
      const tree = (ExplorerService as any)._getTree?.();
      const node = tree?._findNodeById?.(treeNodeId);
      if (node?.isDir) {
        attachmentInputChat?.addAttachment?.({ kind: 'folder', path: treeNodeId, name: name + '/' });
      } else {
        attachmentInputChat?.addAttachment?.({ kind: 'file', path: treeNodeId, name });
      }
      toast(`已添加: ${name}`, 'success');
    } else if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      toast('请使用文件菜单或目录树添加文件', 'info');
    }
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanups.push(() => target.removeEventListener(type, listener));
  }
}

if (chatAttachmentInputApp) {
  chatAttachmentInputApp.ChatViews = {
    ...(chatAttachmentInputApp.ChatViews || {}),
    ChatAttachmentInputView,
    createAttachmentInput: () => new ChatAttachmentInputView(),
  };
}

export {};
