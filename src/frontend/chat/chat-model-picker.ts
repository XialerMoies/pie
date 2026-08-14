/// <reference path="../dashboard.d.ts" />

interface ChatPickerModel {
  provider: string;
  id: string;
}

class ChatModelPickerView {
  private picker: HTMLElement | null = null;
  private outsideClick: ((event: MouseEvent) => void) | null = null;

  open(event: MouseEvent): void {
    const existing = $('model-picker');
    if (existing) {
      this.close();
      existing.remove();
      return;
    }

    const target = (event.currentTarget as HTMLElement | null) || $('fi-model-btn');
    if (!target) return;
    fetch('/api/models').then(response => response.json()).then((data: { models?: ChatPickerModel[] }) => {
      if (!data.models || !data.models.length) {
        toast('没有可用模型');
        return;
      }
      this.render(data.models, target);
    }).catch((error) => {
      console.error('[model picker]', error);
      toast('加载模型列表失败');
    });
  }

  close(): void {
    this.picker?.remove();
    this.picker = null;
    if (this.outsideClick) {
      document.removeEventListener('click', this.outsideClick, true);
      this.outsideClick = null;
    }
  }

  private render(models: ChatPickerModel[], target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const picker = document.createElement('div');
    picker.id = 'model-picker';
    picker.className = 'model-picker';
    picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    picker.style.left = `${rect.left}px`;

    const modelList = document.createElement('div');
    modelList.className = 'model-picker-list';
    const grouped: Record<string, ChatPickerModel[]> = {};
    for (const model of models) {
      if (!grouped[model.provider]) grouped[model.provider] = [];
      grouped[model.provider].push(model);
    }
    for (const [provider, providerModels] of Object.entries(grouped)) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:.6rem;font-weight:600;text-transform:uppercase;color:var(--tm);padding:6px 10px 3px;letter-spacing:.05em;font-family:var(--fd)';
      header.textContent = provider;
      modelList.appendChild(header);
      for (const model of providerModels) this.appendModel(modelList, provider, model);
    }

    picker.appendChild(modelList);
    App.Chat?.mountThinkingControl?.(picker);
    document.body.appendChild(picker);
    this.picker = picker;
    this.outsideClick = (event: MouseEvent) => {
      if (!picker.contains(event.target as Node) && event.target !== target) this.close();
    };
    setTimeout(() => {
      if (this.outsideClick) document.addEventListener('click', this.outsideClick, true);
    }, 0);
  }

  private appendModel(list: HTMLElement, provider: string, model: ChatPickerModel): void {
    const item = document.createElement('div');
    const dashboard = App.ChatState.getDashboard();
    const active = model.provider === dashboard?.modelProvider && model.id === dashboard?.modelId;
    item.style.cssText = `padding:6px 10px;border-radius:4px;cursor:pointer;font-size:.78rem;font-family:var(--fm);color:${active ? 'var(--am)' : 'var(--ts)'};background:${active ? 'rgba(245,158,11,.1)' : 'transparent'}`;
    item.textContent = model.id;
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--bc)'; });
    item.addEventListener('mouseleave', () => { item.style.background = active ? 'rgba(245,158,11,.1)' : 'transparent'; });
    item.addEventListener('click', () => {
      fetch('/api/model/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId: model.id }),
      }).then(response => response.json()).then((result: { ok: boolean; error?: string }) => {
        if (result.ok) {
          toast('已切换 ' + model.id, 'success');
          getD();
          void App.Chat?.syncThinkingLevel?.();
          this.close();
        } else {
          toast('切换失败: ' + (result.error || ''), 'error');
        }
      }).catch(() => toast('切换失败', 'error'));
    });
    list.appendChild(item);
  }
}

const chatModelPicker = new ChatModelPickerView();
const chatModelPickerApp = (window as any).App;
if (chatModelPickerApp) {
  chatModelPickerApp.ChatViews = {
    ...(chatModelPickerApp.ChatViews || {}),
    ChatModelPickerView,
    openModelPicker: (event: MouseEvent) => chatModelPicker.open(event),
  };
}

export {};
