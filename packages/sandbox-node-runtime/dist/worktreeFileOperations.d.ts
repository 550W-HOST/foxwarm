import { type FileOperations } from '../../shared/dist/fileOperations';
export declare function assertWorktreePath(rootInput: string, candidateInput: string, existing: boolean): Promise<string>;
export declare function createWorktreeFileOperations(root: string): FileOperations;
