export const shouldEnableSessionListDrag = (requested: boolean, primaryPointerCoarse: boolean): boolean => {
  return requested && !primaryPointerCoarse
}

export const shouldActivateSessionListDrag = (enabled: boolean, pointerType: string): boolean => {
  return enabled && pointerType === 'mouse'
}