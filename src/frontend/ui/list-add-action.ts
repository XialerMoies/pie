/// <reference path="../dashboard.d.ts" />

interface ListAddActionOptions {
  id?: string;
  label: string;
  disabled?: boolean;
  onActivate: () => void;
}

export class ListAddAction {
  static create(options: ListAddActionOptions): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "list-add-action";
    if (options.id) button.id = options.id;
    button.disabled = options.disabled ?? false;

    const icon = document.createElement("span");
    icon.className = "list-add-action-icon";
    icon.textContent = "+";

    const label = document.createElement("span");
    label.className = "list-add-action-label";
    label.textContent = options.label;

    button.append(icon, label);
    button.addEventListener("click", options.onActivate);
    return button;
  }
}

const listAddActionApp = (window as any).App || ((window as any).App = {});
listAddActionApp.Ui = listAddActionApp.Ui || {};
listAddActionApp.Ui.ListAddAction = ListAddAction;
