export class WorkflowEntrypoint<TEnv = unknown, TParams = unknown> {
	protected ctx: unknown;
	protected env: TEnv;
	constructor(ctx: unknown, env: TEnv) {
		this.ctx = ctx;
		this.env = env;
		void (null as unknown as TParams);
	}
}

export type WorkflowEvent<T> = {
	payload: T;
	timestamp: Date;
	instanceId: string;
};

export type WorkflowStep = {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	sleep(name: string, duration: string | number): Promise<void>;
};
