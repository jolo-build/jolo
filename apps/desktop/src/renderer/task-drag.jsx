import { createContext, useContext } from 'react';

export const TaskDragContext = createContext(null);
export const TASK_DRAG_TYPE = 'application/x-jolo-task';

export function useTaskDrag() {
  const start = useContext(TaskDragContext);
  return (task) => ({
    draggable: Boolean(start && task?.session?.id && task.rootPath),
    onDragStart: event => {
      if (!start || !task?.session?.id || !task.rootPath) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(TASK_DRAG_TYPE, task.session.id);
      start(task);
    },
  });
}

export function taskDropSide(x, y, bounds) {
  const horizontal = (x - bounds.left) / bounds.width;
  const vertical = (y - bounds.top) / bounds.height;
  if (horizontal > .3 && horizontal < .7 && vertical > .3 && vertical < .7) return 'right';
  // Each pair is a side and how far the pointer is from it; the nearest side wins.
  return /** @type {[string, number][]} */ ([ ['left', horizontal], ['right', 1 - horizontal], ['top', vertical], ['bottom', 1 - vertical] ])
    .sort((a, b) => a[1] - b[1])[0][0];
}
