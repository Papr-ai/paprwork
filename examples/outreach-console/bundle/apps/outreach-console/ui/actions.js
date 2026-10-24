import { call } from './api.js';
import { toast } from './dom.js';

export function createActions(refresh) {
  /** Runs an action, disables the button meanwhile, reports the outcome, then refreshes. */
  return async function act(button, action, params, done) {
    button.disabled = true;
    try {
      await call(action, params);
      toast(done);
      await refresh();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
}
