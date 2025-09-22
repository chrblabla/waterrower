import fs from "fs"
import mqtt, { MqttClient } from "mqtt"

import { SportingDevice, Measurement } from "./index"

export class ActivityRecorder {
  private GARMIN_EPOCH = 631065600
  private recordingInterval: NodeJS.Timeout
  private fitTimestampStart = Math.floor(Date.now() / 1000) - this.GARMIN_EPOCH
  private fileWriter: fs.WriteStream
  private mqttClient: MqttClient

  private sportingDevices: SportingDevice[] = []
  private measurements: Measurement[] = []

  constructor(sportingDevices: SportingDevice[]) {
    this.sportingDevices = sportingDevices
    sportingDevices.forEach((device) => {
      this.measurements.push(...device.measurements)
    })

    // Set up connection to MQTT for the data collection
    this.mqttClient = mqtt.connect("mqtt://localhost")
    this.mqttClient.on("message", (topic: string, payload: Buffer) => {
      const measurement = this.measurements.find(m => topic.endsWith(m.metric))
      const message = payload.toString();

      if (measurement) {
        measurement.value = parseFloat(message)
      }
    })
  }

  start = async () => {
    if (!this.recordingInterval) {
      console.log("Starting new session")

      // Subscribe to the topics of all sporting devices
      this.sportingDevices.forEach((device) => {
        // TODO: reset?

        device.measurements.forEach((measurement) => {
          this.mqttClient.subscribe(`${device.type}/${measurement.metric}`, (err) => {
            if (err) {
              console.error("Failed to subscribe to MQTT topic:", err)
            }
          })
        })
      })

      this.openFile()

      this.recordingInterval = setInterval(() => {
        this.record()
      }, 1000) // FIT files have a second-based resolution
    }
  }

  openFile = () => {
    const now = Date.now()
    this.fitTimestampStart = Math.floor(Date.now() / 1000) - this.GARMIN_EPOCH
    this.fileWriter = fs.createWriteStream(`trainings/${now}.fit.csv`)
    this.fileWriter.write("Type,Local Number,Message,Field 1,Value 1,Units 1,Field 2,Value 2,Units 2,Field 3,Value 3,Units 3,Field 4,Value 4,Units 4,Field 5,Value 5,Units 5,Field 6,Value 6,Units 6\n")
    this.fileWriter.write("Definition,0,file_id,serial_number,1,,time_created,1,,manufacturer,1,,type,1,\n")
    this.fileWriter.write(`Data,0,file_id,serial_number,\"${this.fitTimestampStart}\",,time_created,\"${this.fitTimestampStart}\",,manufacturer,\"118\",,type,\"4\",\n`)
    this.fileWriter.write("Definition,1,record,timestamp,1,,distance,1,,power,1,,cadence,1,,speed,1,,total_cycles,1,,heart_rate,1,,\n")
    this.fileWriter.write("Definition,2,session,timestamp,1,,start_time,1,,total_elapsed_time,1,total_distance,1,,total_cycles,1,,sport,1,,sub_sport,1,\n")
    this.fileWriter.write("Definition,3,activity,timestamp,1,,num_sessions,1,\n")
  }

  closeFile = () => {
    // const fitTimestampEnd = Math.floor(Date.now() / 1000) - GARMIN_EPOCH
    // const sessionDuration = fitTimestampEnd - this.fitTimestampStart

    // this.fileWriter.write(`Data,2,session,timestamp,\"${this.fitTimestampStart}\",s,start_time,\"${this.fitTimestampStart}\",,`)
    // this.fileWriter.write(`total_elapsed_time,\"${sessionDuration}\",s,`)
    // this.fileWriter.write(`total_distance,\"${this.distance.value}\",m,`)
    // this.fileWriter.write(`total_cycles,\"${this.strokes.value}\",cycles,`)
    // this.fileWriter.write("sport,\"15\",,sub_sport,\"14\",\n")

    // this.fileWriter.write(`Data,3,activity,timestamp,\"${this.fitTimestampStart}\",,num_sessions,\"1\",\n`)
  }

  stop = (exit: boolean) => {
    // // stop recording
    // if (this.port) {
    //   this.port.off("data", this.onData)
    // }

    // if (this.recordingInterval) {
    //   clearInterval(this.recordingInterval)
    //   this.recordingInterval = null
    // }

    // if (this.lastStrokeTimestamp) {
    //   clearInterval(this.lastStrokeTimestamp)
    //   this.lastStrokeTimestamp = null
    // }

    // console.log("Finalizing workout file")

    // // finalize workout file
    // const fitTimestampEnd = Math.floor(Date.now() / 1000) - GARMIN_EPOCH
    // const sessionDuration = fitTimestampEnd - this.fitTimestampStart
    // this.fileWriter.write(`Data,2,session,timestamp,\"${this.fitTimestampStart}\",s,start_time,\"${this.fitTimestampStart}\",,`)
    //   this.fileWriter.write(`total_elapsed_time,\"${sessionDuration}\",s,`)
    //   this.fileWriter.write(`total_distance,\"${this.distance.value}\",m,`)
    //   this.fileWriter.write(`total_cycles,\"${this.strokes.value}\",cycles,`)
    //   this.fileWriter.write("sport,\"15\",,sub_sport,\"14\",\n")
    // this.fileWriter.write(`Data,3,activity,timestamp,\"${this.fitTimestampStart}\",,num_sessions,\"1\",\n`)
    // this.fileWriter.close(() => {
    //   if (exit) {
    //     process.exit()
    //   }
    // })
  }

  private record = () => {
    // const now = Date.now()
    // const fitTimestamp = Math.floor(now / 1000) - GARMIN_EPOCH

    // this.fileWriter.write(`Data,1,record,timestamp,"${fitTimestamp}",s,`)
    // this.fileWriter.write(`${this.distance.metric},"${this.distance.value}",${this.distance.unit},`)
    // this.fileWriter.write(`${this.power.metric},"${this.power.value}",${this.power.unit},`)
    // this.fileWriter.write(`${this.strokes.metric},"${this.strokes.value}",${this.strokes.unit},`)
    // this.fileWriter.write(`${this.speed.metric},"${this.speed.value}",${this.speed.unit},`)
    // this.fileWriter.write(`${this.cadence.metric},"${this.cadence.value}",${this.cadence.unit},`)
    // // this.fileWriter.write(`${this.heartRate.metric},"${this.heartRate.value}",${this.heartRate.unit},`)
    // this.fileWriter.write("\n")
  }

  // TODO: reset
}
