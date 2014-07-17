package org.opentreemap.modeling

import geotrellis.server

import akka.io.IO
import akka.actor.Props
import spray.can.Http

object Main {
  def main(args: Array[String]) {
    implicit val system = server.system

    // create and start our the service actor
    val service =
      system.actorOf(Props(classOf[ModelingServiceActor]), "opentreemap-modeling-service")

    // start a new HTTP server with the service actor as the handler
    IO(Http) ! Http.Bind(service, ServiceConfig.host, port = ServiceConfig.port)
  }
}

