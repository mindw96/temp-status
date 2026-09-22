CREATE TABLE `gpu_history` (
	`key` text PRIMARY KEY NOT NULL,
	`node` text NOT NULL,
	`minute` integer NOT NULL,
	`utilization` real,
	`gpu_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_gpu_history_minute` ON `gpu_history` (`minute`);--> statement-breakpoint
CREATE TABLE `reports` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL
);
