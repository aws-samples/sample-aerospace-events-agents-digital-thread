"""Handler registry — maps MSK topics to domain handler functions."""

from handlers.qms import handle as qms_handle
from handlers.mes import handle as mes_handle
from handlers.plm import handle as plm_handle
from handlers.erp import handle as erp_handle
from handlers.srm import handle as srm_handle
from handlers.wms import handle as wms_handle
from handlers.dhr import handle as dhr_handle
from handlers.program import handle as program_handle
from handlers.inservice import handle as inservice_handle
from handlers.scada import handle as scada_handle

TOPIC_HANDLERS = {
    'aerospace.qms.events': qms_handle,
    'aerospace.mes.events': mes_handle,
    'aerospace.plm.events': plm_handle,
    'aerospace.erp.events': erp_handle,
    'aerospace.srm.events': srm_handle,
    'aerospace.wms.events': wms_handle,
    'aerospace.dhr.events': dhr_handle,
    'aerospace.program.events': program_handle,
    'aerospace.inservice.events': inservice_handle,
    'aerospace.scada.events': scada_handle,
}
