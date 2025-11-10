// describes one kind of message: info about the stream
export type Meta = {
    type: "meta";
    sessionID: string;
    series: string[];
    hz: number;
};

// describes one actual data point
export type Point = {
    type: "point";
    t: number //timestamp (ms)
    speed?: number;
    current?: number;
    temp?: number;
};

// marks the end of a stream
export type End = {
    type: "end";
    reason?: string;
};

export type telemetryMsg = Meta | Point | End;
