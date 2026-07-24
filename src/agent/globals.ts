/**
 * 全局引用——零依赖，避免 cycles
 *
 * runtime.ts 和 prompts.ts 都 import 此模块，不产生循环依赖。
 */
let _currentRuntime: any | null = null;

export function setCurrentRuntime(r: any | null): void {
  _currentRuntime = r;
}

export function getCurrentRuntime(): any | null {
  return _currentRuntime;
}
