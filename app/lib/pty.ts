import * as nodePTY from '@terminus-term/node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024
    private maxDelta = 1024 * 50
    private flowPaused = false

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) { }

    push (data: Buffer) {
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        this.delta -= length
        this.maybeEmit()
    }

    private maybeEmit () {
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta && !this.flowPaused) {
                this.pause()
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.onData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                setImmediate(() => this.maybeEmit())
            }
        }
    }

    private pause () {
        this.pty.pause()
        this.flowPaused = true
    }

    private resume () {
        this.pty.resume()
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue

    constructor (private id: string, private app: Application, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)
        for (const key of ['close', 'exit']) {
            (this.pty as any).on(key, (...eventArgs) => this.emit(key, ...eventArgs))
        }

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data-buffered', data))
        })

        this.pty.on('data', data => this.outputQueue.push(Buffer.from(data)))
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if ((this.pty as any)._writable) {
            this.pty.resize(columns, rows)
        }
    }

    write (buffer: Buffer): void {
        if ((this.pty as any)._writable) {
            this.pty.write(buffer.toString())
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    kill (signal?: string): void {
        this.pty.kill(signal)
    }

    private emit (event: string, ...args: any[]) {
        this.app.broadcast(`pty:${this.id}:${event}`, ...args)
    }
}

export class PTYManager {
    private ptys: Record<string, PTY> = {}

    init (app: Application): void {
        //require('./bufferizedPTY')(nodePTY) // eslint-disable-line @typescript-eslint/no-var-requires
        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            this.ptys[id] = new PTY(id, app, ...options)
        })

        ipcMain.on('pty:exists', (event, id) => {
            event.returnValue = !!this.ptys[id]
        })

        ipcMain.on('pty:get-pid', (event, id) => {
            event.returnValue = this.ptys[id].getPID()
        })

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys[id].resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys[id].write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            this.ptys[id].kill(signal)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys[id].ackData(length)
        })
    }
}
